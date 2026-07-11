// Injected by the service worker into every served page. It keeps the swarm alive: a
// main-thread WebTorrent client re-seeds the site's files straight from the Cache API, so
// while a visitor has any page of the site open, they are a source for everyone else.
//
// This runs on the main thread because WebRTC does not exist in any worker. It reseeds from
// cache, reproducing the original torrent so the infohash matches — verified below; a mismatch
// means it would be seeding a different torrent, so we log it and stop rather than pollute.
import WebTorrent from "/vendor/webtorrent.v2.min.js";
import { siteCacheName, TRACKERS } from "/common.js";
import { track } from "/telemetry.js";

const LOG = "[wt-reseed]";
const hash = location.hostname.split(".")[0].toLowerCase();

// One reseeder per document; guard against double-injection.
if (!globalThis.__wtdReseeding) {
  globalThis.__wtdReseeding = true;
  reseed().catch((e) => console.warn(LOG, "reseed failed:", e));
}

async function reseed() {
  const cache = await caches.open(siteCacheName(hash));
  const mres = await cache.match("/__wtd/manifest");
  if (!mres) {
    console.warn(LOG, "no manifest; cannot reseed");
    return;
  }
  const manifest = await mres.json();

  // Rebuild the ORIGINAL files (in torrent order, with their original paths) so create-torrent
  // produces the same infohash. The generated index (if any) is deliberately excluded.
  const files = [];
  for (const m of manifest.files) {
    const res = await cache.match("/" + m.rel.split("/").map(encodeURIComponent).join("/"));
    if (!res) continue;
    const blob = await res.blob();
    const file = new File([blob], m.rel.split("/").pop());
    file.fullPath = m.path;
    files.push(file);
  }
  if (!files.length) return;

  const client = new WebTorrent();
  client.on("error", (e) => console.warn(LOG, "client error:", e));
  client.seed(files, { name: manifest.name || undefined, announce: TRACKERS }, (torrent) => {
    const match = torrent.infoHash.toLowerCase() === hash;
    if (match) {
      console.log(LOG, "reseeding", torrent.infoHash, "(infohash matches — feeding the swarm)");
      track("reseed-ok", { infoHash: hash, files: files.length });
    } else {
      console.warn(LOG, "infohash MISMATCH: got", torrent.infoHash, "expected", hash, "— stopping");
      track("reseed-mismatch", { infoHash: hash, got: torrent.infoHash });
      torrent.destroy(); // do not seed a different torrent
    }
  });
}
