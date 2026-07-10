// The drop page: turn a dropped folder into a torrent and seed it from this tab.
import { formatBytes, LOG, randomKey, sha256Hex, shareUrl, TRACKERS } from "/common.js";
import { track } from "/telemetry.js";

/**
 * Register a freshly-seeded site and hand back the owner's private activity-log URL.
 * We mint a random owner key, send only its hash to the server (so the server can gate the
 * log to us without ever holding the key), and keep the key in localStorage so the same
 * browser keeps access across reloads.
 */
async function registerSite(infoHash, meta) {
  const storeKey = `wtd-owner-${infoHash}`;
  let key = localStorage.getItem(storeKey);
  if (!key) {
    key = randomKey();
    try {
      localStorage.setItem(storeKey, key);
    } catch { /* private mode: the link below still works this session */ }
  }
  try {
    const ownerKeyHash = await sha256Hex(key);
    await fetch("/_register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ infoHash, ownerKeyHash, meta }),
    });
  } catch (err) {
    console.warn(LOG, "register failed (activity log may be unavailable):", err);
  }
  return `/_site?hash=${infoHash}&key=${key}`;
}

const dropEl = document.getElementById("drop");
const dirEl = document.getElementById("dir");
// NB: id must not be "files" — the <ul> listing the seeded files already owns that id.
const filesInputEl = document.getElementById("filePick");
const dropTitleEl = document.getElementById("dropTitle");
const statusEl = document.getElementById("status");
const stateEl = document.getElementById("state");
const statsEl = document.getElementById("stats");
const dotEl = document.getElementById("dot");
const shareEl = document.getElementById("share");
const urlEl = document.getElementById("url");
const copyEl = document.getElementById("copy");
const openEl = document.getElementById("open");
const activityEl = document.getElementById("activity");
const filesEl = document.getElementById("files");
const errorEl = document.getElementById("error");

function fail(msg) {
  console.error(LOG, "error:", msg);
  errorEl.textContent = msg;
  errorEl.hidden = false;
  statusEl.hidden = true;
  track("drop-fail", { msg: String(msg).slice(0, 200) });
}

// Construct WebTorrent lazily and guarded. Building it at module top meant that if the
// constructor threw (a bad browser, a blocked API), the whole module aborted, no handlers
// attached, and selecting a folder did nothing with no visible error. Now any failure
// surfaces in the UI instead of vanishing into the console.
let client = null;
function getClient() {
  if (!client) {
    client = new WebTorrent();
    client.on("error", (err) => fail(err.message || String(err)));
  }
  return client;
}

/**
 * Recursively read a dropped directory entry into File objects.
 * `create-torrent` reads `file.fullPath` to preserve directory structure, so we set it.
 */
function readEntry(entry, path = "") {
  if (entry.isFile) {
    return new Promise((resolve, reject) =>
      entry.file((file) => {
        file.fullPath = path + file.name;
        resolve([file]);
      }, reject)
    );
  }
  const reader = entry.createReader();
  const dir = path + entry.name + "/";
  // readEntries only returns a batch at a time; keep calling until it returns nothing.
  const readAll = (acc = []) =>
    new Promise((resolve, reject) =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(acc);
        resolve(readAll(acc.concat(batch)));
      }, reject)
    );
  return readAll().then((entries) =>
    Promise.all(entries.map((e) => readEntry(e, dir))).then((groups) => groups.flat())
  );
}

async function filesFromDataTransfer(dt) {
  const entries = [...dt.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) throw new Error("Could not read that. Try the folder picker instead.");
  const groups = await Promise.all(entries.map((e) => readEntry(e)));
  return groups.flat();
}

/** Files from <input webkitdirectory> already carry webkitRelativePath. Mirror it to fullPath. */
function filesFromInput(list) {
  return [...list].map((file) => {
    file.fullPath = file.webkitRelativePath || file.name;
    return file;
  });
}

/** The single path segment shared by every file, e.g. "myfolder", or "" if there is none. */
function commonRoot(files) {
  const firsts = files.map((f) => (f.fullPath || f.name).split("/"));
  if (!firsts.every((p) => p.length > 1)) return "";
  const root = firsts[0][0];
  return firsts.every((p) => p[0] === root) ? root : "";
}

/**
 * Build a browsable index.html for a folder that doesn't have one, so any drop produces a
 * viewable site instead of an error. Links are relative to where the index will live (the
 * common root), so they resolve through the service worker just like a hand-written page.
 */
function generateIndexFile(files, root) {
  const prefix = root ? root + "/" : "";
  const rows = files
    .map((f) => {
      const full = f.fullPath || f.name;
      const rel = full.startsWith(prefix) ? full.slice(prefix.length) : full;
      const href = rel.split("/").map(encodeURIComponent).join("/");
      const safe = rel.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `      <li><a href="${href}">${safe}</a><span>${formatBytes(f.size)}</span></li>`;
    })
    .join("\n");
  const title = root || "Dropped files";
  const html = `<!doctype html>
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
  const file = new File([html], "index.html", { type: "text/html" });
  file.fullPath = prefix + "index.html";
  return file;
}

function seed(files) {
  if (!files.length) return fail("That was empty. Nothing to seed.");

  errorEl.hidden = true;
  const root = commonRoot(files);
  const hasIndex = files.some((f) => /(^|\/)index\.html$/i.test(f.fullPath || f.name));

  // No entry page? Generate a file browser so the drop still becomes a working site.
  let generated = false;
  if (!hasIndex) {
    files = [generateIndexFile(files, root), ...files];
    generated = true;
    console.log(LOG, "no index.html; generated a file browser");
  }

  // Torrent name = the dropped folder's name, when there is a common root.
  const name = root || undefined;

  const total = files.reduce((n, f) => n + f.size, 0);
  console.log(LOG, `seeding ${files.length} files, ${formatBytes(total)}`);
  track("seed-start", { files: files.length, bytes: total, generated });
  const seedT0 = performance.now();

  statusEl.hidden = false;
  stateEl.textContent = "Hashing…";
  statsEl.textContent = `${files.length} files · ${formatBytes(total)}`;

  filesEl.replaceChildren(
    ...files.slice(0, 12).map((f) => {
      const li = document.createElement("li");
      li.textContent = f.fullPath || f.name;
      return li;
    }),
  );
  if (files.length > 12) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = `…and ${files.length - 12} more`;
    filesEl.append(li);
  }

  let wt;
  try {
    wt = getClient();
  } catch (err) {
    return fail("WebTorrent could not start in this browser: " + (err.message || err));
  }

  wt.seed(files, { name, announce: TRACKERS }, (torrent) => {
    console.log(LOG, "seeding", torrent.infoHash, torrent.magnetURI);
    track("seed-ready", {
      infoHash: torrent.infoHash,
      files: files.length,
      bytes: total,
      generated,
      hashMs: Math.round(performance.now() - seedT0),
    });
    let firstPeer = false;
    const url = shareUrl(torrent.infoHash);
    urlEl.value = url;
    openEl.href = url;
    shareEl.hidden = false;
    dotEl.classList.add("is-live");
    stateEl.textContent = generated ? "Seeding (file browser)" : "Seeding";

    // Register the site and reveal the owner's private activity log.
    registerSite(torrent.infoHash, { name: name ?? null, files: files.length, bytes: total })
      .then((activityUrl) => {
        activityEl.href = activityUrl;
        activityEl.hidden = false;
      });

    const tick = () => {
      statsEl.textContent = `${torrent.numPeers} peer${torrent.numPeers === 1 ? "" : "s"} · ` +
        `${formatBytes(torrent.uploaded)} sent · ${formatBytes(torrent.length)} total`;
    };
    tick();
    torrent.on("upload", tick);
    torrent.on("wire", () => {
      console.log(LOG, "peer connected, now", torrent.numPeers);
      if (!firstPeer) {
        firstPeer = true;
        track("seed-first-peer", {
          infoHash: torrent.infoHash,
          waitMs: Math.round(performance.now() - seedT0),
        });
      }
      tick();
    });
    setInterval(tick, 2000);
  });
}

// Warn before the tab closes, because closing it kills the site.
addEventListener("beforeunload", (e) => {
  if (client?.torrents.length) {
    e.preventDefault();
    e.returnValue = "";
  }
});

dropEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropEl.classList.add("is-over");
});
dropEl.addEventListener("dragleave", () => dropEl.classList.remove("is-over"));
dropEl.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropEl.classList.remove("is-over");
  errorEl.hidden = true;
  statusEl.hidden = false;
  stateEl.textContent = "Reading files…";
  try {
    seed(await filesFromDataTransfer(e.dataTransfer));
  } catch (err) {
    fail(err.message || String(err));
  }
});

// The folder picker (webkitdirectory) works on modern mobile too: Chrome Android 132+,
// iOS Safari 18.4+ (per MDN browser-compat-data), plus all desktop. So show it everywhere
// and keep "Choose files" as the alternative for older browsers. Coarse pointers cannot
// drag, so just adjust the wording.
if (matchMedia("(pointer: coarse)").matches) {
  dropTitleEl.textContent = "Choose a folder to host";
}

// Clicking the zone opens the folder picker, but never swallow clicks already headed for a
// real <label>/<input>, or we would open and immediately re-open the dialog.
dropEl.addEventListener("click", (e) => {
  if (e.target.closest("label, input")) return;
  dirEl.click();
});

for (const input of [dirEl, filesInputEl]) {
  input.addEventListener("change", () => {
    console.log(LOG, "picker change:", input.id, input.files.length, "files");
    if (!input.files.length) return;
    // Acknowledge immediately, before any async work, so a selection is never silent.
    statusEl.hidden = false;
    stateEl.textContent = "Reading files…";
    errorEl.hidden = true;
    try {
      seed(filesFromInput(input.files));
    } catch (err) {
      fail(err.message || String(err));
    }
  });
}

copyEl.addEventListener("click", async () => {
  await navigator.clipboard.writeText(urlEl.value);
  const label = copyEl.querySelector("span");
  label.textContent = "Copied";
  setTimeout(() => (label.textContent = "Copy"), 1400);
});

console.log(LOG, "drop page ready");
