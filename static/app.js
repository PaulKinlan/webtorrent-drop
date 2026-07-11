// The drop page: turn a dropped folder into a torrent and seed it from this tab.
// The vendored WebTorrent bundle is an ES module with a default export, so it must be
// imported here rather than loaded as a classic <script> (which throws on `export`).
import WebTorrent from "/vendor/webtorrent.v2.min.js";
import {
  commonRoot,
  formatBytes,
  generateIndexHtml,
  LOG,
  mimeFor,
  randomKey,
  sha256Hex,
  shareUrl,
  TRACKERS,
} from "/common.js";
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
  const activityUrl = `/_site?hash=${infoHash}&key=${key}`;
  try {
    const ownerKeyHash = await sha256Hex(key);
    const res = await fetch("/_register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ infoHash, ownerKeyHash, meta }),
    });
    if (!res.ok) {
      let reason = `registration failed (${res.status})`;
      try {
        reason = (await res.json()).error || reason;
      } catch { /* non-JSON */ }
      console.warn(LOG, "register rejected:", reason);
      // 422 = the site failed validation, so it will NOT be served on unhosted.dev.
      return { activityUrl: null, ok: false, reason };
    }
  } catch (err) {
    // A network error should not block the UX; the site is still seeding, and if it was
    // registered on a prior load the gate still passes.
    console.warn(LOG, "register failed (activity log may be unavailable):", err);
  }
  return { activityUrl, ok: true, reason: null };
}

/**
 * Build the registration summary the server validates against (index.html present, web file
 * types, size caps) and stores for the admin per-site view. Keep the allowlist logic in step
 * with ALLOWED_EXT in telemetry.ts.
 */
function siteMeta(files, name) {
  let bytes = 0;
  let hasIndex = false;
  const exts = new Set();
  for (const f of files) {
    const path = f.fullPath || f.name || "";
    bytes += f.size || 0;
    if (/(^|\/)index\.html?$/i.test(path)) hasIndex = true;
    const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
    if (ext) exts.add(ext);
  }
  return {
    name: name ?? null,
    count: files.length,
    bytes,
    hasIndex,
    exts: [...exts].slice(0, 60),
    // A short sample of paths for the admin per-site drill-down; not the whole tree.
    sample: files.slice(0, 50).map((f) => ({ path: f.fullPath || f.name, size: f.size || 0 })),
  };
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
const confirmEl = document.getElementById("confirm");
const confirmBodyEl = document.getElementById("confirmBody");
const persistEl = document.getElementById("persist");
const shareBtnEl = document.getElementById("shareBtn");
const restoredEl = document.getElementById("restored");
const restoredListEl = document.getElementById("restoredList");

// The most recent successful seed, so the persist toggle knows what to save.
let lastSeed = null;

// ── Persist across reloads ─────────────────────────────────────────────────────────────
// "Keep alive" copies the seeded files into the Cache API (chosen over OPFS/IndexedDB: it
// reuses the viewer's reseed path, needs no permission prompt, and gives an immutable snapshot
// so the infohash stays stable — a live directory handle could change and break the share URL).
// On load we re-seed anything saved. Storage is per-origin, so this never touches hosted sites.
const PERSIST_KEY = "wtd-persisted";
const persistIndex = () => {
  try {
    return JSON.parse(localStorage.getItem(PERSIST_KEY) || "[]");
  } catch {
    return [];
  }
};
const setPersistIndex = (a) => localStorage.setItem(PERSIST_KEY, JSON.stringify(a));
const seedCache = (infoHash) => `wtd-seed-${infoHash}`;

async function persistSeed({ infoHash, name, files }) {
  const cache = await caches.open(seedCache(infoHash));
  const manifest = { infoHash, name, files: [] };
  for (const f of files) {
    await cache.put(
      "/" + f.fullPath.split("/").map(encodeURIComponent).join("/"),
      new Response(f, { headers: { "content-type": mimeFor(f.fullPath) } }),
    );
    manifest.files.push({ path: f.fullPath, size: f.size });
  }
  await cache.put(
    "/__manifest",
    new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } }),
  );
  const idx = persistIndex();
  if (!idx.some((x) => x.infoHash === infoHash)) {
    idx.push({ infoHash, name: name || null });
    setPersistIndex(idx);
  }
  console.log(LOG, "persisted", infoHash);
  renderRestored();
}

async function unpersistSeed(infoHash) {
  await caches.delete(seedCache(infoHash));
  setPersistIndex(persistIndex().filter((x) => x.infoHash !== infoHash));
  console.log(LOG, "unpersisted", infoHash);
  renderRestored();
}

async function restorePersisted() {
  for (const { infoHash, name } of persistIndex()) {
    try {
      const cache = await caches.open(seedCache(infoHash));
      const mres = await cache.match("/__manifest");
      if (!mres) continue;
      const manifest = await mres.json();
      const files = [];
      for (const m of manifest.files) {
        const res = await cache.match("/" + m.path.split("/").map(encodeURIComponent).join("/"));
        if (!res) continue;
        const blob = await res.blob();
        const file = new File([blob], m.path.split("/").pop());
        file.fullPath = m.path;
        files.push(file);
      }
      if (!files.length) continue;
      getClient().seed(files, { name: name || undefined, announce: TRACKERS }, (t) => {
        if (t.infoHash.toLowerCase() !== infoHash.toLowerCase()) {
          console.warn(LOG, "persisted reseed infohash mismatch:", t.infoHash, "vs", infoHash);
        } else {
          console.log(LOG, "re-seeding saved site", infoHash);
        }
      });
    } catch (e) {
      console.warn(LOG, "restore failed for", infoHash, e);
    }
  }
  renderRestored();
}

function renderRestored() {
  const idx = persistIndex();
  restoredEl.hidden = idx.length === 0;
  restoredListEl.replaceChildren(
    ...idx.map(({ infoHash, name }) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = shareUrl(infoHash);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = name || infoHash.slice(0, 12) + "…";
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "restored__remove";
      rm.title = "Stop keeping this alive";
      rm.textContent = "×";
      rm.addEventListener("click", () => unpersistSeed(infoHash));
      li.append(a, rm);
      return li;
    }),
  );
}

if (persistEl) {
  persistEl.addEventListener("change", async () => {
    if (!lastSeed) return;
    if (persistEl.checked) await persistSeed(lastSeed);
    else await unpersistSeed(lastSeed.infoHash);
  });
}

// ── Web Share ──────────────────────────────────────────────────────────────────────────
if (shareBtnEl && "share" in navigator) {
  shareBtnEl.addEventListener("click", async () => {
    try {
      await navigator.share({
        title: "A site on unhosted.dev",
        text: "I'm hosting this from my browser, peer-to-peer:",
        url: urlEl.value,
      });
    } catch { /* user cancelled the share sheet; ignore */ }
  });
}

// Safari has no `closedby` support yet, so add the light-dismiss (click-outside) fallback.
if (!("closedBy" in HTMLDialogElement.prototype)) {
  confirmEl.addEventListener("click", (e) => {
    if (e.target !== confirmEl) return; // clicks inside the form bubble to the dialog
    const r = confirmEl.getBoundingClientRect();
    const inside = r.top <= e.clientY && e.clientY <= r.top + r.height &&
      r.left <= e.clientX && e.clientX <= r.left + r.width;
    if (!inside) confirmEl.close("cancel");
  });
}

/** Ask the user to confirm before a folder is shared publicly. Resolves true to proceed. */
function confirmUpload(files) {
  const total = files.reduce((n, f) => n + (f.size || 0), 0);
  confirmBodyEl.textContent = `${files.length} file${files.length === 1 ? "" : "s"}, ${
    formatBytes(total)
  }.`;
  confirmEl.returnValue = "";
  confirmEl.showModal();
  return new Promise((resolve) => {
    confirmEl.addEventListener(
      "close",
      () => resolve(confirmEl.returnValue === "share"),
      { once: true },
    );
  });
}

/** Confirm, then seed. Called from both the drop and picker paths. */
async function startSeed(files) {
  if (!files.length) return fail("That was empty. Nothing to seed.");
  if (!(await confirmUpload(files))) {
    statusEl.hidden = true; // cancelled
    return;
  }
  seed(files);
}

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
// Prove the WebTorrent module import resolved to a constructor (for verification/debugging).
globalThis.__WT = typeof WebTorrent === "function";
document.documentElement.dataset.wt = String(globalThis.__WT);
console.log(LOG, "WebTorrent module loaded:", globalThis.__WT);

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

/**
 * Build a browsable index.html File for a folder that doesn't have one, so any drop produces a
 * viewable site. The HTML itself comes from the shared generateIndexHtml.
 */
function generateIndexFile(files, root) {
  const prefix = root ? root + "/" : "";
  const html = generateIndexHtml(files, root);
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

    // Persist toggle + Web Share button, now that there is a share URL.
    lastSeed = { infoHash: torrent.infoHash, name, files };
    persistEl.checked = persistIndex().some((x) => x.infoHash === torrent.infoHash);
    if ("share" in navigator) shareBtnEl.hidden = false;

    // Register the site (this also gates it into unhosted.dev) and reveal the activity log.
    registerSite(torrent.infoHash, siteMeta(files, name)).then((r) => {
      if (r.ok && r.activityUrl) {
        activityEl.href = r.activityUrl;
        activityEl.hidden = false;
      } else if (!r.ok) {
        dotEl.classList.remove("is-live");
        stateEl.textContent = "Not servable on unhosted.dev";
        fail(
          "This won't be served on unhosted.dev: " + (r.reason || "it must be a website") +
            ". It needs an index.html and only web file types (no video archives, etc.).",
        );
      }
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
    await startSeed(await filesFromDataTransfer(e.dataTransfer));
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
  input.addEventListener("change", async () => {
    console.log(LOG, "picker change:", input.id, input.files.length, "files");
    if (!input.files.length) return;
    // Acknowledge immediately, before any async work, so a selection is never silent.
    statusEl.hidden = false;
    stateEl.textContent = "Reading files…";
    errorEl.hidden = true;
    try {
      await startSeed(filesFromInput(input.files));
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

// Programmatic seed hook, for automated testing (no upload click needed). Pass
// [{path, content}] and it seeds them exactly like a dropped folder, resolving with the
// infohash and share URL. e.g. await globalThis.__wtdSeed([{path:'site/index.html', content:'<h1>hi'}])
globalThis.__wtdSeed = (specs) => {
  const files = specs.map((s) => {
    const f = new File([s.content], s.path.split("/").pop() || "file", {
      type: mimeFor(s.path),
    });
    f.fullPath = s.path;
    return f;
  });
  const root = commonRoot(files);
  const hasIndex = files.some((f) => /(^|\/)index\.html$/i.test(f.fullPath));
  const all = hasIndex ? files : [generateIndexFile(files, root), ...files];
  return new Promise((resolve, reject) => {
    try {
      getClient().seed(all, { name: root || undefined, announce: TRACKERS }, (torrent) => {
        registerSite(torrent.infoHash, siteMeta(all, root));
        resolve({
          infoHash: torrent.infoHash,
          magnet: torrent.magnetURI,
          url: shareUrl(torrent.infoHash),
          files: all.map((f) => f.fullPath),
        });
      });
    } catch (e) {
      reject(e);
    }
  });
};

// Re-seed any sites the user chose to keep alive, and list them.
restorePersisted().catch((e) => console.warn(LOG, "restore error:", e));

console.log(LOG, "drop page ready");
