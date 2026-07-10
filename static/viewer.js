// The viewer: join the swarm for this page's infohash and render the site from it.
//
// The WebTorrent service worker answers /webtorrent/* by messaging a *window client* of
// this origin that holds a running WebTorrent server. That client is this page. So this
// page must stay alive: we render the site in an iframe rather than navigating to it.
import {
  currentInfoHash,
  findEntryFile,
  formatBytes,
  LOG,
  readyServiceWorker,
  TRACKERS,
} from "/common.js";

const stateEl = document.getElementById("state");
const statsEl = document.getElementById("stats");
const hintEl = document.getElementById("hint");
const barEl = document.getElementById("bar");
const errorEl = document.getElementById("error");
const overlayEl = document.getElementById("overlay");
const frameEl = document.getElementById("frame");

function fail(msg) {
  console.error(LOG, "error:", msg);
  stateEl.textContent = "Could not load this site";
  errorEl.textContent = msg;
  errorEl.hidden = false;
  barEl.style.width = "0%";
}

const infoHash = currentInfoHash();
if (!infoHash) {
  fail("No torrent infohash in this URL.");
} else {
  main(infoHash).catch((err) => fail(err.message || String(err)));
}

async function main(hash) {
  console.log(LOG, "viewing", hash);
  document.title = `${hash.slice(0, 8)}… · webtorrent-drop`;

  const controller = await readyServiceWorker();

  const client = new WebTorrent();
  client.on("error", (err) => fail(err.message || String(err)));

  // Stand up the in-page HTTP server the service worker proxies to.
  client.createServer({ controller });
  console.log(LOG, "webtorrent server created");

  // If nobody is seeding, add() simply never fires metadata. Say so rather than hang.
  const noPeers = setTimeout(() => {
    if (!errorEl.hidden) return;
    hintEl.textContent =
      "Still looking. If the person who made this site closed their tab, it is gone for good.";
  }, 12000);

  const torrent = client.add(hash, { announce: TRACKERS });

  torrent.on("wire", () => {
    console.log(LOG, "peer connected, now", torrent.numPeers);
    statsEl.textContent = `${torrent.numPeers} peer${torrent.numPeers === 1 ? "" : "s"}`;
  });

  torrent.on("metadata", () => {
    console.log(LOG, "got metadata:", torrent.name, torrent.files.length, "files");
    clearTimeout(noPeers);
    stateEl.textContent = `Fetching ${torrent.name}…`;
  });

  torrent.on("download", () => {
    const pct = Math.round(torrent.progress * 100);
    barEl.style.width = `${pct}%`;
    statsEl.textContent =
      `${pct}% · ${formatBytes(torrent.downloaded)} of ${formatBytes(torrent.length)} · ` +
      `${torrent.numPeers} peer${torrent.numPeers === 1 ? "" : "s"}`;
  });

  torrent.on("ready", () => {
    const entry = findEntryFile(torrent);
    if (!entry) {
      return fail("This torrent has no index.html, so there is no page to show.");
    }
    // WebTorrent exposes the exact URL its in-page server answers on, of the shape
    // /webtorrent/<infoHash>/<encoded file path>. Prefer it over hand-building the path.
    // Using the file's real path means relative links and assets inside the page resolve.
    const src = entry.streamURL ??
      `/webtorrent/${torrent.infoHash}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
    console.log(LOG, "entry:", entry.path, "->", src);

    stateEl.textContent = "Rendering…";
    frameEl.addEventListener("load", () => {
      overlayEl.hidden = true;
      frameEl.hidden = false;
      document.title = torrent.name;
      console.log(LOG, "rendered; now seeding to others while this tab is open");
    }, { once: true });
    frameEl.src = src;
  });
}
