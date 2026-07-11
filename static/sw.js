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

// App assets and APIs the SW must NOT intercept — they always come from the origin.
function isReserved(path) {
  if (path.startsWith("/vendor/")) return true;
  if (path.startsWith("/_")) return true; // /_beacon /_report /_register /_site /_admin /__wtd
  return [
    "/sw.js",
    "/viewer.js",
    "/reseed.js",
    "/common.js",
    "/telemetry.js",
    "/app.js",
    "/styles.css",
    "/favicon.ico",
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
    return res;
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
  const headers = new Headers(res.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(html, { status: 200, statusText: "OK", headers });
}

console.log(LOG, "loaded for", self.location.hostname, "infohash:", infoHash());
void MANIFEST;
