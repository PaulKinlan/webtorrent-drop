// The shell / bootstrap. Served by the origin for any not-yet-cached path on a site's
// subdomain. It:
//   1. registers our service worker,
//   2. downloads the whole torrent over WebTorrent (on the main thread — WebRTC),
//   3. writes every file into the Cache API at its REAL path (common folder stripped) with a
//      correct content-type, plus a manifest for reseeding,
//   4. reloads — after which the SW serves the site natively at real URLs.
//
// WebTorrent's on-demand streaming still exists; we choose full-download-then-cache here so
// that afterwards the whole site is navigable offline from cache with real URLs.
import WebTorrent from "/vendor/webtorrent.v2.min.js";
import {
  commonRoot,
  generateIndexHtml,
  mimeFor,
  relPath,
  siteCacheName,
  TRACKERS,
} from "/common.js";
import { track } from "/telemetry.js";

const LOG = "[wt-shell]";
const stateEl = document.getElementById("state");
const statsEl = document.getElementById("stats");
const hintEl = document.getElementById("hint");
const barEl = document.getElementById("bar");
const errorEl = document.getElementById("error");

const hash = location.hostname.split(".")[0].toLowerCase();
const t0 = performance.now();

function fail(msg) {
  console.error(LOG, "error:", msg);
  stateEl.textContent = "Could not load this site";
  errorEl.textContent = msg;
  errorEl.hidden = false;
  track("shell-fail", { infoHash: hash, msg: String(msg).slice(0, 200) });
}

track("shell-start", { infoHash: hash, path: location.pathname });
main().catch((e) => fail(e.message || String(e)));

/** Resolve once the SW controls this page (or after a timeout), so a reload is intercepted. */
function untilControlled(ms) {
  return new Promise((res) => {
    if (navigator.serviceWorker.controller) return res();
    const t = setTimeout(res, ms);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      clearTimeout(t);
      res();
    }, { once: true });
  });
}

async function main() {
  if (!("serviceWorker" in navigator)) throw new Error("No service worker support.");
  if (!isSecureContext) throw new Error("Needs a secure context (https).");

  // Loop guard. The shell reloads once the site is cached so the SW can serve it. If the SW
  // ISN'T serving it (stale worker, or not yet controlling this page), the shell would load
  // again, see the cache, and reload forever — hammering the origin. Count consecutive shell
  // loads and bail instead of looping.
  const shellLoads = Number(sessionStorage.getItem("wtd-shell-loads") || "0") + 1;
  sessionStorage.setItem("wtd-shell-loads", String(shellLoads));

  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  console.log(LOG, "service worker ready; shell load", shellLoads);

  const cache = await caches.open(siteCacheName(hash));
  if (await cache.match("/index.html")) {
    if (shellLoads > 2) {
      sessionStorage.removeItem("wtd-shell-loads");
      return fail(
        "The site is saved but the service worker isn't serving it. Clear this site's data " +
          "(DevTools → Application → Clear storage) and reload.",
      );
    }
    console.log(LOG, "already cached — waiting for SW control, then reloading once");
    await untilControlled(3000);
    return location.reload();
  }

  // Fresh download path: reset the loop guard.
  sessionStorage.removeItem("wtd-shell-loads");

  const client = new WebTorrent();
  client.on("error", (e) => fail(e.message || String(e)));

  const noPeers = setTimeout(() => {
    if (errorEl.hidden) {
      hintEl.textContent =
        "Still looking for peers. If whoever made this site closed their tab, it may be gone.";
    }
  }, 12000);

  const torrent = client.add(hash, { announce: TRACKERS });

  torrent.on("wire", () => {
    statsEl.textContent = `${torrent.numPeers} peer${torrent.numPeers === 1 ? "" : "s"}`;
  });
  torrent.on("metadata", () => {
    clearTimeout(noPeers);
    track("shell-metadata", {
      infoHash: hash,
      files: torrent.files.length,
      bytes: torrent.length,
      waitMs: Math.round(performance.now() - t0),
    });
    stateEl.textContent = `Downloading ${torrent.name}…`;
  });
  torrent.on("download", () => {
    const pct = Math.round(torrent.progress * 100);
    barEl.style.width = `${pct}%`;
    statsEl.textContent = `${pct}% · ${fmt(torrent.downloaded)} of ${fmt(torrent.length)} · ` +
      `${torrent.numPeers} peer${torrent.numPeers === 1 ? "" : "s"}`;
  });

  torrent.on("done", async () => {
    clearTimeout(noPeers);
    console.log(LOG, "download complete — caching", torrent.files.length, "files");
    stateEl.textContent = "Saving…";
    barEl.style.width = "100%";
    try {
      await cacheAll(cache, torrent);
    } catch (e) {
      return fail("Could not store the site: " + (e.message || e));
    }
    track("shell-cached", {
      infoHash: hash,
      files: torrent.files.length,
      bytes: torrent.length,
      totalMs: Math.round(performance.now() - t0),
    });
    console.log(LOG, "cached; reloading to serve from SW at real URLs");
    location.reload();
  });
}

// Write each file into the Cache at its real, root-relative path with the right content-type.
// Also store a manifest of the ORIGINAL files (not any generated index) so reseeding can
// reproduce the exact torrent / infohash.
async function cacheAll(cache, torrent) {
  const files = torrent.files;
  const root = commonRoot(files);
  const manifest = { infoHash: torrent.infoHash, name: torrent.name, root, files: [] };
  let hasIndex = false;

  for (const f of files) {
    const rel = relPath(f.path, root);
    if (rel.toLowerCase() === "index.html") hasIndex = true;
    const blob = await f.blob();
    await cache.put(
      "/" + rel.split("/").map(encodeURIComponent).join("/"),
      new Response(blob, {
        headers: { "content-type": mimeFor(rel), "cache-control": "no-store" },
      }),
    );
    manifest.files.push({ path: f.path, rel, size: f.length });
  }

  if (!hasIndex) {
    const html = generateIndexHtml(files.map((f) => ({ fullPath: f.path, size: f.length })), root);
    await cache.put(
      "/index.html",
      new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    manifest.generatedIndex = true;
  }

  await cache.put(
    "/__wtd/manifest",
    new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } }),
  );
}

function fmt(n) {
  if (!n) return "0 B";
  const u = ["B", "kB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
