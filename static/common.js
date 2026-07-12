// Shared helpers for both the drop page and the viewer.

export const LOG = "[wt-drop]";

// Public WebRTC signalling trackers. Browser peers cannot find each other without a
// wss tracker: WebRTC needs an out-of-band channel to swap SDP offers before any data
// flows. These are community-run and periodically flaky; self-hosting one is the single
// biggest reliability win available (see the idea file).
// These are the three wss trackers WebTorrent itself ships as defaults, so they are the
// most likely to actually be up. They are still community-run and periodically flaky.
export const TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
  "wss://tracker.btorrent.xyz",
];

/** The Cache API name that holds a site's files, keyed by infohash. */
export function siteCacheName(hash) {
  return `wtd-site-${hash}`;
}

// Correct content-types are what make the served site behave like a real website — the old
// iframe path served text/html as the wrong type, so text was unreadable.
const MIME = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wasm: "application/wasm",
  pdf: "application/pdf",
};

export function mimeFor(path) {
  const ext = path.split(".").pop().toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/**
 * The single path segment shared by every file, e.g. "myfolder", or "" if there is none.
 * Prefer the FULL path (`fullPath` on dropped File objects, `path` on WebTorrent's torrent.files)
 * over `name` — WebTorrent sets `.name` to the basename, which would hide the common folder and
 * leave every file served under "/myfolder/…" instead of the root.
 */
export function commonRoot(files) {
  const firsts = files.map((f) => (f.fullPath || f.path || f.name).split("/"));
  if (!firsts.length || !firsts.every((p) => p.length > 1)) return "";
  const root = firsts[0][0];
  return firsts.every((p) => p[0] === root) ? root : "";
}

/** A file's path relative to the site root (common folder stripped). */
export function relPath(fullPath, root) {
  const prefix = root ? root + "/" : "";
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

/** Build a browsable index.html for a folder that has none, so any drop is viewable. */
export function generateIndexHtml(files, root) {
  const rows = files
    .map((f) => {
      const rel = relPath(f.fullPath || f.path || f.name, root);
      const href = rel.split("/").map(encodeURIComponent).join("/");
      const safe = rel.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `      <li><a href="${href}">${safe}</a><span>${
        formatBytes(f.size ?? f.length)
      }</span></li>`;
    })
    .join("\n");
  const title = root || "Dropped files";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem;
    background:#0f1115;color:#e6e9ef}
  @media (prefers-color-scheme:light){body{background:#fff;color:#111}}
  h1{font-size:1.3rem} p.note{color:#9aa4b2;font-size:.9rem}
  ul{list-style:none;padding:0;border-top:1px solid #ffffff22}
  li{display:flex;justify-content:space-between;gap:1rem;padding:.5rem .25rem;
    border-bottom:1px solid #ffffff14}
  a{color:#6ea8fe;text-decoration:none;word-break:break-all} a:hover{text-decoration:underline}
  span{color:#9aa4b2;font-variant-numeric:tabular-nums;flex:none}
</style></head><body>
  <h1>${title.replace(/</g, "&lt;")}</h1>
  <p class="note">No <code>index.html</code> was in this folder, so this listing was generated
  automatically. ${files.length} file${files.length === 1 ? "" : "s"}.</p>
  <ul>
${rows}
  </ul>
</body></html>`;
}

const HEX40 = /^[0-9a-f]{40}$/i;
const BASE32 = /^[a-z2-7]{32}$/i;

export function isInfoHash(s) {
  return HEX40.test(s) || BASE32.test(s);
}

/**
 * Work out which torrent this page is for, mirroring the server's logic.
 * Subdomain wins (<infohash>.domain), then the first path segment (/<infohash>).
 * Returns null on the drop page.
 */
export function currentInfoHash() {
  const label = location.hostname.split(".")[0];
  if (isInfoHash(label)) return label.toLowerCase();
  const first = location.pathname.slice(1).split("/")[0];
  if (isInfoHash(first)) return first.toLowerCase();
  return null;
}

/**
 * Build the shareable URL for a hash. Uses a wildcard subdomain when one is available,
 * otherwise falls back to a path. We can only use the subdomain form when the current
 * host is a registrable domain we control a wildcard on — on *.deno.net and localhost
 * that is not true, so we fall back to the path form.
 */
export function shareUrl(infoHash) {
  const host = location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1";
  // *.deno.net gives each app one fixed subdomain, so we cannot mint <hash>.<app>.deno.net.
  const wildcardCapable = !isLocal && !host.endsWith(".deno.net");
  if (wildcardCapable) {
    // Strip any existing hash label so re-sharing from a viewer page still works.
    const parts = host.split(".");
    if (isInfoHash(parts[0])) parts.shift();
    return `${location.protocol}//${infoHash}.${parts.join(".")}/`;
  }
  return `${location.origin}/${infoHash}`;
}

/** Register the WebTorrent service worker at root scope and wait for it to be ready. */
export async function readyServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("This browser has no service worker support, so the site cannot be served.");
  }
  if (!isSecureContext) {
    throw new Error("Service workers need a secure context (https or localhost).");
  }
  const controller = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  console.log(LOG, "service worker ready, scope:", controller.scope);
  return controller;
}

/**
 * Pick the entry document of a torrent. Prefer a root-level index.html, then any
 * index.html, then the first .html file. Returns the torrent File, or null.
 */
export function findEntryFile(torrent) {
  const html = torrent.files.filter((f) => /\.x?html?$/i.test(f.name));
  if (!html.length) return null;
  const depth = (f) => f.path.split("/").length;
  const indexes = html.filter((f) => f.name.toLowerCase() === "index.html");
  const pool = indexes.length ? indexes : html;
  return pool.sort((a, b) => depth(a) - depth(b))[0];
}

/** A strong random hex key, used as a per-site owner secret. */
export function randomKey() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of a string as lowercase hex. Matches the server's sha256Hex. */
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function formatBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "kB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
