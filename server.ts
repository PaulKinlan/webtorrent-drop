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

const PORT = Number(Deno.env.get("PORT") ?? 8000);

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
        // The app is tiny and changes rarely; the vendored bundle is versioned by content.
        "cache-control": name.startsWith("vendor/") ? "public, max-age=86400" : "no-cache",
        ...extraHeaders,
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const hostHash = infoHashFromHost(req.headers.get("host") ?? url.hostname);

  // The WebTorrent service worker must be served from the origin root so its scope
  // covers /webtorrent/*. Service-Worker-Allowed lets it claim the root scope.
  if (path === "/sw.js") {
    return staticFile("vendor/sw.min.js", { "service-worker-allowed": "/" });
  }

  const ASSETS = ["/styles.css", "/app.js", "/viewer.js", "/common.js"];
  if (path.startsWith("/vendor/") || ASSETS.includes(path)) {
    return staticFile(path.slice(1));
  }

  // Requests under /webtorrent/ are meant to be answered by the service worker, which
  // streams them out of the swarm. Reaching the server means the SW is not controlling
  // this client yet. Say so loudly rather than 404ing mysteriously.
  if (path.startsWith("/webtorrent/")) {
    return new Response(
      "The service worker is not active yet, so this request reached the origin. " +
        "Reload the page. (This server never has your files.)",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // Subdomain mode: <infohash>.domain serves the viewer for that hash.
  if (hostHash) {
    if (path === "/" || path === "/index.html") return staticFile("viewer.html");
    return new Response("Not found", { status: 404 });
  }

  // Path mode (stopgap): /<infohash> serves the viewer.
  const first = path.slice(1).split("/")[0];
  if (first && isInfoHash(first)) return staticFile("viewer.html");

  if (path === "/" || path === "/index.html") return staticFile("index.html");

  return new Response("Not found", { status: 404 });
});

console.log(`webtorrent-drop on http://localhost:${PORT}`);
