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
  const key = ["ev", Number.MAX_SAFE_INTEGER - at, id];
  await kv.set(key, rec, { expireIn: TTL_MS });
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

  if (path === "/_admin" && req.method === "GET") {
    return await admin(req);
  }

  return null;
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
  const given = url.searchParams.get("token") ?? req.headers.get("x-admin-token") ?? "";

  if (!token) {
    return new Response(
      "Admin view is disabled: set the REPORT_ADMIN_TOKEN environment variable.",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  if (!given || !timingSafeEqual(given, token)) {
    return new Response("Forbidden", { status: 403 });
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
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return new Response(adminHtml(events), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  <h1>telemetry — ${events.length} recent event${events.length === 1 ? "" : "s"}</h1>
  <div>${summary || '<span class="small">nothing yet</span>'}</div>
</header>
${
    events.length
      ? `<table><tbody>${rows}</tbody></table>`
      : `<p class="empty">No events stored yet. They arrive as browsers hit errors, send beacons, or the Reporting API fires.</p>`
  }
</body></html>`;
}
