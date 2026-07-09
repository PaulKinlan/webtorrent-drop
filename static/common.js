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

export function formatBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "kB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
