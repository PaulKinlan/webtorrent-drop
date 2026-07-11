// webtorrent-drop — an ephemeral, peer-to-peer static site host.
//
// Drop a folder in the browser. It is turned into a torrent, seeded from your tab
// over WebTorrent, and you get a link. A visitor opening that link gets a bootstrap
// page from this server, which registers a service worker and pulls the site out of
// the swarm. This server never sees, stores, or serves the dropped files. It only
// ever serves the app.
//
// Addressing, in priority order:
//   1. <infohash>.example.com   (wildcard custom domain — the real thing)
//   2. example.com/<infohash>   (stopgap while no wildcard domain is attached)
//
// Deno Deploy supports wildcard custom domains with auto Let's Encrypt TLS on the Pro
// plan, so (1) lights up as soon as a domain is attached. No code change needed.
//
//   deno task dev     # http://localhost:8000

import { handleTelemetry } from "./telemetry.ts";

const PORT = Number(Deno.env.get("PORT") ?? 8000);

// Point browsers' Reporting API at our own endpoint. A `default` endpoint automatically
// receives deprecation, intervention, and crash reports. Our app also POSTs custom events
// to /_beacon. Both land in Deno KV; inspect at /_admin (token-gated).
//
// The CSP is Report-Only: it enforces nothing (so it can never break a page) but makes the
// browser post any violation to /_report. report-to is the modern channel; report-uri is
// the legacy one still honoured by many browsers. This is the "report-uri" error reporting.
const HTML_HEADERS = {
  "reporting-endpoints": 'default="/_report"',
  "content-security-policy-report-only":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self' wss: https:; frame-src 'self' blob:; " +
    "object-src 'none'; base-uri 'none'; report-to default; report-uri /_report",
};

/** A v1 infohash is 40 hex chars; a base32 one is 32 chars. Both are legal DNS labels. */
const HEX40 = /^[0-9a-f]{40}$/i;
const BASE32 = /^[a-z2-7]{32}$/i;

function isInfoHash(s: string): boolean {
  return HEX40.test(s) || BASE32.test(s);
}

/** Pull an infohash out of the hostname's first label, if it looks like one. */
function infoHashFromHost(host: string): string | null {
  const label = host.split(":")[0].split(".")[0];
  return isInfoHash(label) ? label.toLowerCase() : null;
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
};

async function staticFile(name: string, extraHeaders: HeadersInit = {}): Promise<Response> {
  try {
    const body = await Deno.readFile(new URL(`./static/${name}`, import.meta.url));
    const ext = name.split(".").pop() ?? "";
    return new Response(body, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        // no-cache (revalidate every load) while the prototype iterates, so a fixed bundle
        // or script actually reaches browsers instead of a stale 24h-cached copy.
        "cache-control": "no-cache",
        ...extraHeaders,
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

Deno.serve({ port: PORT }, async (req, info) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const hostHash = infoHashFromHost(req.headers.get("host") ?? url.hostname);

  // Telemetry endpoints (/_beacon, /_report, /_admin) come first.
  const tele = await handleTelemetry(req, path, info);
  if (tele) return tele;

  // Our own service worker, at the origin root so its scope covers the whole site.
  if (path === "/sw.js") {
    return staticFile("sw.js", { "service-worker-allowed": "/" });
  }

  // Browsers request /favicon.ico by default; point them at our SVG icon.
  if (path === "/favicon.ico") {
    return Response.redirect(new URL("/favicon.svg", url), 301);
  }

  // App assets, always served from the origin (the SW never intercepts these).
  const ASSETS = [
    "/styles.css",
    "/app.js",
    "/viewer.js",
    "/reseed.js",
    "/common.js",
    "/telemetry.js",
    "/favicon.svg",
  ];
  if (path.startsWith("/vendor/") || ASSETS.includes(path)) {
    return staticFile(path.slice(1));
  }

  // On a site's subdomain, every non-reserved path serves the shell. On a first visit (or a
  // shared deep link before the SW is active) the shell downloads the torrent, caches it, and
  // reloads — after which the service worker serves that path from cache at its real URL.
  if (hostHash) {
    return staticFile("viewer.html", HTML_HEADERS);
  }

  // Path mode (stopgap for hosts without a wildcard domain): /<infohash>… serves the shell.
  const first = path.slice(1).split("/")[0];
  if (first && isInfoHash(first)) return staticFile("viewer.html", HTML_HEADERS);

  if (path === "/" || path === "/index.html") return staticFile("index.html", HTML_HEADERS);

  return new Response("Not found", { status: 404 });
});

console.log(`webtorrent-drop on http://localhost:${PORT}`);
