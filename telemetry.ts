// Client observability for webtorrent-drop.
//
// Collects three things into Deno KV so we can inspect what actually happens in real
// browsers and fix things later:
//   1. POST /_beacon   — our own app events (errors, WebTorrent failures, timings,
//                        lifecycle) sent via navigator.sendBeacon from telemetry.js.
//   2. POST /_report   — browser-generated reports (deprecation, intervention, crash),
//                        delivered by the Reporting API because we set Reporting-Endpoints.
//   3. GET  /_admin    — a read view of recent events, gated by a secret token.
//
// Data hygiene (per the modern-web security guide, §2.3): we never want PII or secrets in
// here. Client IPs are truncated to /16 (v4) or /48 (v6) at the edge before storage, and
// the client module is written to send diagnostic shape, not user content. Everything has
// a TTL so the store self-cleans.

const kv = await Deno.openKv();

const TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_BODY = 32 * 1024; // refuse oversized posts
const MAX_LIST = 1000;

const HEX40 = /^[0-9a-f]{40}$/i;
const BASE32 = /^[a-z2-7]{32}$/i;
function isInfoHash(s: unknown): s is string {
  return typeof s === "string" && (HEX40.test(s) || BASE32.test(s));
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Truncate an IP so a log of "who loaded what" is coarse: IPv4 -> /16, IPv6 -> /48. */
export function truncateIp(raw: string | null): string {
  if (!raw) return "";
  let ip = raw.split(",")[0].trim();
  // Deno Deploy's remoteAddr reports IPv4 clients as IPv4-mapped IPv6 (::ffff:a.b.c.d).
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) ip = mapped[1];
  if (ip.includes(":")) {
    // IPv6: keep the first 3 hextets (/48), zero the rest.
    const parts = ip.split(":");
    return parts.slice(0, 3).join(":") + "::/48";
  }
  const o = ip.split(".");
  if (o.length === 4) return `${o[0]}.${o[1]}.0.0/16`;
  return "";
}

// The new Deno Deploy platform does not forward a client IP header (no x-forwarded-for),
// so the connection's remoteAddr is the source of truth; headers are a fallback for other
// hosts / local dev.
function clientIp(req: Request, info?: Deno.ServeHandlerInfo): string {
  const fromHeader = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip");
  const fromConn = info?.remoteAddr && "hostname" in info.remoteAddr
    ? info.remoteAddr.hostname
    : null;
  return truncateIp(fromHeader ?? fromConn ?? null);
}

type Stored = {
  id: string;
  at: number;
  kind: "beacon" | "report";
  ipPrefix: string;
  ua: string;
  host: string;
  ref: string;
  data: unknown;
};

async function store(
  kind: Stored["kind"],
  data: unknown,
  req: Request,
  at: number,
  id: string,
  info?: Deno.ServeHandlerInfo,
) {
  const rec: Stored = {
    id,
    at,
    kind,
    ipPrefix: clientIp(req, info),
    ua: (req.headers.get("user-agent") ?? "").slice(0, 300),
    host: req.headers.get("host") ?? "",
    // Referer without its query string, so we never store secrets that rode along in a URL.
    ref: (req.headers.get("referer") ?? "").split("?")[0].slice(0, 300),
    data,
  };
  // Key sorts newest-first: a smaller leading number lists earlier in ascending order.
  const rev = Number.MAX_SAFE_INTEGER - at;
  const atomic = kv.atomic().set(["ev", rev, id], rec, { expireIn: TTL_MS });
  // Also index under the site's infohash so its owner can pull just their activity.
  const ih = (data as { infoHash?: unknown })?.infoHash;
  if (isInfoHash(ih)) {
    atomic.set(["site-ev", ih.toLowerCase(), rev, id], rec, { expireIn: TTL_MS });
  }
  await atomic.commit();
}

async function readBody(req: Request): Promise<unknown | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return null;
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000); // keep non-JSON bodies (some report senders) as text
  }
}

/** Handle the telemetry routes. Returns null for paths this module does not own. */
export async function handleTelemetry(
  req: Request,
  path: string,
  info?: Deno.ServeHandlerInfo,
): Promise<Response | null> {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  if ((path === "/_beacon" || path === "/_report") && req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (path === "/_beacon" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return new Response("too large", { status: 413, headers: cors });
    const now = Date.now();
    const events = Array.isArray(body) ? body : [body];
    for (const ev of events.slice(0, 50)) {
      await store("beacon", ev, req, now, crypto.randomUUID(), info);
    }
    // sendBeacon ignores the response, but be well-behaved for fetch callers.
    return new Response(null, { status: 204, headers: cors });
  }

  if (path === "/_report" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return new Response("too large", { status: 413, headers: cors });
    const now = Date.now();
    // The Reporting API posts an array of report objects.
    const reports = Array.isArray(body) ? body : [body];
    for (const r of reports.slice(0, 50)) {
      await store("report", r, req, now, crypto.randomUUID(), info);
    }
    return new Response(null, { status: 204, headers: cors });
  }

  // Seed-time registration: the drop page tells us a new site exists and the SHA-256 of an
  // owner key it generated (we never see the raw key). This both records the site and gates
  // its activity log to whoever holds the key.
  if (path === "/_register" && req.method === "POST") {
    const body = await readBody(req);
    const b = body as { infoHash?: unknown; ownerKeyHash?: unknown; meta?: unknown };
    if (!isInfoHash(b?.infoHash) || typeof b?.ownerKeyHash !== "string") {
      return new Response("bad request", { status: 400, headers: cors });
    }
    const ih = b.infoHash.toLowerCase();
    // First writer wins: do not let a later caller overwrite an existing owner key.
    const existing = await kv.get(["site", ih]);
    if (!existing.value) {
      await kv.set(
        ["site", ih],
        { at: Date.now(), ownerKeyHash: b.ownerKeyHash.slice(0, 64), meta: b.meta ?? null },
        { expireIn: TTL_MS },
      );
    }
    return new Response(null, { status: 204, headers: cors });
  }

  if (path === "/_site" && req.method === "GET") {
    return await siteLog(req);
  }

  if (path === "/_admin" && req.method === "POST") {
    return await adminLogin(req);
  }
  if (path === "/_admin" && req.method === "GET") {
    return await admin(req);
  }

  return null;
}

const SESSION_MS = 12 * 60 * 60 * 1000; // 12h admin session

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function hasAdminSession(req: Request): Promise<boolean> {
  const sid = parseCookies(req)["wtd_admin"];
  if (!sid) return false;
  return !!(await kv.get(["admin-session", sid])).value;
}

/** Verify the admin password from a login form and, on success, start a cookie session. */
async function adminLogin(req: Request): Promise<Response> {
  const token = Deno.env.get("REPORT_ADMIN_TOKEN");
  if (!token) return new Response("Admin disabled", { status: 503 });

  const form = new URLSearchParams(await req.text());
  const pw = form.get("password") ?? "";
  if (!pw || !timingSafeEqual(pw, token)) {
    return new Response(loginForm("Wrong password."), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" },
    });
  }
  const sid = crypto.randomUUID();
  await kv.set(["admin-session", sid], { at: Date.now() }, { expireIn: SESSION_MS });
  // HttpOnly (JS can't read it), Secure (HTTPS only), SameSite=Strict (no cross-site sends).
  return new Response(null, {
    status: 303,
    headers: {
      "location": "/_admin",
      "set-cookie": `wtd_admin=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${
        SESSION_MS / 1000
      }`,
      "referrer-policy": "no-referrer",
    },
  });
}

function loginForm(error = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>admin · unhosted.dev</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e9ef;display:grid;
    place-items:center;min-height:100dvh;margin:0}
  form{background:#161a20;border:1px solid #262b33;border-radius:12px;padding:1.5rem;width:min(22rem,90vw)}
  h1{font-size:1rem;margin:0 0 1rem}
  input{width:100%;box-sizing:border-box;padding:.6rem;border-radius:8px;border:1px solid #262b33;
    background:#0f1115;color:#e6e9ef;font:inherit}
  button{margin-top:.75rem;width:100%;padding:.6rem;border-radius:8px;border:0;background:#2563eb;
    color:#fff;font:inherit;font-weight:600;cursor:pointer}
  .err{color:#f87171;font-size:.85rem;margin:.5rem 0 0}
</style></head><body>
<form method="post" action="/_admin" autocomplete="off">
  <h1>unhosted.dev — telemetry</h1>
  <input type="password" name="password" placeholder="Admin password" autofocus required>
  <button type="submit">Sign in</button>
  ${error ? `<p class="err">${esc(error)}</p>` : ""}
</form>
</body></html>`;
}

// Owner-scoped activity log: every viewer loads the bootstrap from us, so these are the
// real "requests for your share". Gated by the owner key minted at seed time — the infohash
// alone is public (it is the share URL), so it must not be enough to read the log.
async function siteLog(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const hash = (url.searchParams.get("hash") ?? "").toLowerCase();
  const key = url.searchParams.get("key") ?? "";
  if (!isInfoHash(hash) || !key) return new Response("bad request", { status: 400 });

  const site = await kv.get<{ ownerKeyHash: string; meta: unknown; at: number }>(["site", hash]);
  if (!site.value) return new Response("Unknown site", { status: 404 });
  if (!timingSafeEqual(await sha256Hex(key), site.value.ownerKeyHash)) {
    return new Response("Forbidden", { status: 403 });
  }

  const events: Stored[] = [];
  for await (
    const entry of kv.list<Stored>({ prefix: ["site-ev", hash] }, { limit: MAX_LIST })
  ) {
    events.push(entry.value);
    if (events.length >= 500) break;
  }

  if (url.searchParams.get("format") === "json") {
    return new Response(JSON.stringify({ hash, count: events.length, events }, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "referrer-policy": "no-referrer",
      },
    });
  }
  return new Response(siteHtml(hash, events), {
    headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function admin(req: Request): Promise<Response> {
  const token = Deno.env.get("REPORT_ADMIN_TOKEN");
  const url = new URL(req.url);

  if (!token) {
    return new Response(
      "Admin view is disabled: set the REPORT_ADMIN_TOKEN environment variable.",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // Log out: drop the session and clear the cookie.
  if (url.searchParams.get("logout") !== null) {
    const sid = parseCookies(req)["wtd_admin"];
    if (sid) await kv.delete(["admin-session", sid]);
    return new Response(loginForm("Signed out."), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "wtd_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
        "referrer-policy": "no-referrer",
      },
    });
  }

  // Auth is a cookie session (from the login form) or an x-admin-token header (for scripts).
  // Never a URL query param, so the secret can't leak via referer, history, or logs.
  const headerTok = req.headers.get("x-admin-token");
  const authed = (headerTok != null && timingSafeEqual(headerTok, token)) ||
    await hasAdminSession(req);
  if (!authed) {
    return new Response(loginForm(), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" },
    });
  }

  const limit = Math.min(Number(url.searchParams.get("limit") ?? "200"), MAX_LIST);
  const kindFilter = url.searchParams.get("kind"); // "beacon" | "report" | null
  const events: Stored[] = [];
  for await (const entry of kv.list<Stored>({ prefix: ["ev"] }, { limit: MAX_LIST })) {
    const rec = entry.value;
    if (kindFilter && rec.kind !== kindFilter) continue;
    events.push(rec);
    if (events.length >= limit) break;
  }

  if (url.searchParams.get("format") === "json") {
    return new Response(JSON.stringify({ count: events.length, events }, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "referrer-policy": "no-referrer",
      },
    });
  }
  return new Response(adminHtml(events), {
    headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" },
  });
}

function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function siteHtml(hash: string, events: Stored[]): string {
  // Views = someone opened the share link. Count distinct coarse IP prefixes as a rough
  // "visitors" number without ever showing a full address.
  const views = events.filter((e) => (e.data as { event?: string })?.event === "view-start");
  const rendered = events.filter((e) => (e.data as { event?: string })?.event === "view-rendered");
  const noPeers = events.filter((e) => (e.data as { event?: string })?.event === "view-no-peers");
  const visitors = new Set(views.map((e) => e.ipPrefix).filter(Boolean)).size;

  const rows = events.map((e) => {
    const d = e.data as { event?: string; totalMs?: number; waitMs?: number };
    const when = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
    const detail = d.totalMs != null
      ? `${d.totalMs} ms`
      : d.waitMs != null
      ? `waited ${d.waitMs} ms`
      : "";
    return `<tr><td class="mono">${when}</td><td><span class="tag">${
      esc(d.event ?? e.kind)
    }</span></td><td class="mono">${esc(e.ipPrefix || "—")}</td><td class="small">${
      esc((e.ua.match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/) ?? [e.ua.slice(0, 24)])[0])
    }</td><td class="mono small">${esc(detail)}</td></tr>`;
  }).join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>activity · ${hash.slice(0, 8)}…</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#0f1115;color:#e6e9ef}
  header{padding:1.25rem;border-bottom:1px solid #262b33}
  h1{font-size:1.05rem;margin:0 0 .25rem} .sub{color:#9aa4b2;font-size:.85rem;margin:0}
  .stats{display:flex;gap:1.5rem;margin-top:1rem;flex-wrap:wrap}
  .stat b{display:block;font-size:1.5rem;color:#6ea8fe} .stat span{color:#9aa4b2;font-size:.8rem}
  table{border-collapse:collapse;width:100%} td{border-bottom:1px solid #1b2027;padding:.4rem .75rem}
  .mono{font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
  .small{color:#9aa4b2;font-size:.8rem}
  .tag{font-size:.75rem;padding:.1rem .4rem;border-radius:5px;background:#17303c;color:#89dbff}
  .empty{padding:3rem 1.25rem;color:#9aa4b2}
</style></head><body>
<header>
  <h1>activity for your share</h1>
  <p class="sub mono">${esc(hash)}</p>
  <div class="stats">
    <div class="stat"><b>${visitors}</b><span>visitors (by /16)</span></div>
    <div class="stat"><b>${views.length}</b><span>opens</span></div>
    <div class="stat"><b>${rendered.length}</b><span>loaded ok</span></div>
    <div class="stat"><b>${noPeers.length}</b><span>found no peers</span></div>
  </div>
</header>
${
    events.length
      ? `<table><tbody>${rows}</tbody></table>`
      : `<p class="empty">No requests yet. When someone opens your share link, it shows up here.</p>`
  }
</body></html>`;
}

function adminHtml(events: Stored[]): string {
  const byType: Record<string, number> = {};
  for (const e of events) {
    const t = e.kind === "report"
      ? `report:${(e.data as { type?: string })?.type ?? "?"}`
      : `beacon:${(e.data as { event?: string })?.event ?? "?"}`;
    byType[t] = (byType[t] ?? 0) + 1;
  }
  const summary = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<span class="pill">${esc(t)} <b>${n}</b></span>`)
    .join(" ");

  const rows = events.map((e) => {
    const when = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
    const label = e.kind === "report"
      ? (e.data as { type?: string })?.type ?? "report"
      : (e.data as { event?: string })?.event ?? "beacon";
    return `<tr>
      <td class="mono">${when}</td>
      <td><span class="tag ${e.kind}">${esc(label)}</span></td>
      <td class="mono">${esc(e.ipPrefix)}</td>
      <td class="mono small">${esc(e.host)}</td>
      <td><pre>${esc(JSON.stringify(e.data))}</pre></td>
    </tr>`;
  }).join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>webtorrent-drop · telemetry</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#0f1115;color:#e6e9ef}
  header{padding:1rem 1.25rem;border-bottom:1px solid #262b33;position:sticky;top:0;background:#0f1115}
  h1{font-size:1.1rem;margin:0 0 .5rem}
  .pill{display:inline-block;background:#161a20;border:1px solid #262b33;border-radius:999px;
    padding:.15rem .6rem;margin:.15rem;font-size:.8rem}
  .pill b{color:#6ea8fe}
  table{border-collapse:collapse;width:100%}
  td{border-bottom:1px solid #1b2027;padding:.4rem .6rem;vertical-align:top}
  .mono{font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
  .small{color:#9aa4b2;font-size:.8rem}
  pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:.8rem;max-width:60ch;color:#c9d3e0}
  .tag{font-size:.75rem;padding:.1rem .4rem;border-radius:5px}
  .tag.report{background:#3b1d1d;color:#f8b4b4}
  .tag.beacon{background:#17303c;color:#89dbff}
  .empty{padding:3rem 1.25rem;color:#9aa4b2}
</style></head><body>
<header>
  <h1>telemetry — ${events.length} recent event${events.length === 1 ? "" : "s"}
    <a href="/_admin?logout" style="float:right;font-size:.8rem;color:#9aa4b2">sign out</a></h1>
  <div>${summary || '<span class="small">nothing yet</span>'}</div>
</header>
${
    events.length
      ? `<table><tbody>${rows}</tbody></table>`
      : `<p class="empty">No events stored yet. They arrive as browsers hit errors, send beacons, or the Reporting API fires.</p>`
  }
</body></html>`;
}
