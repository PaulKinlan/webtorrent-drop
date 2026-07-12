// Our own service worker (replaces WebTorrent's proxy SW).
//
// Once a site's files are cached (by the shell, which downloads them over WebTorrent on the
// main thread), THIS worker serves them at REAL URLs on the site's origin. So the browser
// navigates natively: the URL bar changes, sub-pages are shareable, refresh works, and files
// are served with correct content-types. It never proxies to a window, so it sets its own
// headers — no WebTorrent frame-ancestors CSP, no iframe.
//
// The WebTorrent client that fetches/reseeds still lives in a window (WebRTC only works on a
// main thread). This SW only serves bytes out of the Cache API.

const LOG = "[wt-sw]";
const HEX40 = /^[0-9a-f]{40}$/i;
const BASE32 = /^[a-z2-7]{32}$/i;

function infoHash() {
  const label = self.location.hostname.split(".")[0];
  return HEX40.test(label) || BASE32.test(label) ? label.toLowerCase() : null;
}
const cacheName = (h) => `wtd-site-${h}`;
const MANIFEST = "/__wtd/manifest";

// Strict CSP enforced on ALL served (hosted) content. A hosted site is untrusted code running
// on its own <infohash>.unhosted.dev origin, so we lock it to its own package: everything must
// be same-origin (i.e. from the swarm, served by us). connect-src is limited to same-origin
// (its own files + our /_beacon) plus the wss trackers our injected reseed.js needs — so the
// hosted page cannot fetch, XHR, or open a socket to any external host (no phone-home, no
// exfiltration, no third-party tracking). 'unsafe-inline' is allowed for scripts/styles because
// arbitrary static sites rely on inline code; that only affects the site's isolation from
// itself, not its ability to reach out (which connect-src governs). WebRTC is not covered by
// connect-src and stays available because reseed.js needs it — a small residual risk noted in
// the security analysis. frame-ancestors 'self' stops the hosted page being framed elsewhere.
const SERVED_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' wss://tracker.openwebtorrent.com wss://tracker.webtorrent.dev wss://tracker.btorrent.xyz",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

function harden(headers) {
  headers.set("content-security-policy", SERVED_CSP);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return headers;
}

// Platform runtime the SW must NOT intercept on a site's subdomain — these always come from the
// origin (the shell, the SW itself, its imports, the telemetry endpoints). Everything else is
// the hosted site's own namespace, served from cache. Note what is DELIBERATELY not here:
// /app.js, /styles.css, /favicon.ico, /ide.js — those are apex-only (the drop page + editor), so
// a hosted site is free to have its own files with those names. Reserving them would shadow the
// site's real files with platform assets (the bug where a demo's own app.js never loaded).
function isReserved(path) {
  if (path.startsWith("/vendor/")) return true;
  if (path.startsWith("/_")) return true; // /_beacon /_report /_register /_site /_admin /__wtd
  return [
    "/sw.js",
    "/viewer.js",
    "/viewer.html",
    "/reseed.js",
    "/common.js",
    "/telemetry.js",
  ].includes(path);
}

function beacon(data) {
  try {
    fetch("/_beacon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ ...data, page: "sw", sw: true }]),
    }).catch(() => {});
  } catch { /* never let telemetry throw */ }
}

self.addEventListener("install", () => {
  console.log(LOG, "install");
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  console.log(LOG, "activate; claiming clients");
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== "GET") return;
  const h = infoHash();
  if (!h) return; // apex / drop page — not a site origin
  if (isReserved(url.pathname)) return; // app asset → straight to network
  event.respondWith(serve(req, url, h));
});

async function serve(req, url, h) {
  const cache = await caches.open(cacheName(h));
  // "/" and directory paths resolve to index.html.
  const key = url.pathname === "/" ? "/index.html" : url.pathname;
  let res = await cache.match(key);
  if (!res && !key.split("/").pop().includes(".")) {
    res = await cache.match(key.replace(/\/+$/, "") + "/index.html");
  }

  if (res) {
    console.log(LOG, "serve from cache:", key, res.headers.get("content-type"));
    if ((res.headers.get("content-type") || "").includes("text/html")) {
      return injectReseed(res);
    }
    return new Response(res.body, {
      status: res.status,
      headers: harden(new Headers(res.headers)),
    });
  }

  // Not cached yet: this is a first visit (or a deep link before the shell has run). Let the
  // request hit the origin, which serves the shell; the shell downloads + caches, then reloads,
  // after which the SW serves everything from cache.
  console.log(LOG, "cache miss:", key, "→ origin shell");
  beacon({ event: "sw-miss", path: key, infoHash: h });
  try {
    return await fetch(req);
  } catch {
    return new Response("Offline and not cached yet.", {
      status: 504,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

// Append our reseed script to served HTML so every page a visitor lands on keeps the swarm fed
// (a main-thread WebTorrent client seeding from the cache — the SW itself can't, no WebRTC).
async function injectReseed(res) {
  let html = await res.text();
  // Must be type="module" — reseed.js uses ES module imports (WebTorrent is an ES module).
  const tag = `\n<script type="module" src="/reseed.js" data-wtd-reseed></script>\n`;
  if (!html.includes("data-wtd-reseed")) {
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + "</body>") : html + tag;
  }
  const headers = harden(new Headers(res.headers));
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(html, { status: 200, statusText: "OK", headers });
}

console.log(LOG, "loaded for", self.location.hostname, "infohash:", infoHash());
void MANIFEST;
