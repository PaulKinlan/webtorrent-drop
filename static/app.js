// The drop page: turn a dropped folder into a torrent and seed it from this tab.
import { formatBytes, LOG, shareUrl, TRACKERS } from "/common.js";

const dropEl = document.getElementById("drop");
const dirEl = document.getElementById("dir");
// NB: id must not be "files" — the <ul> listing the seeded files already owns that id.
const filesInputEl = document.getElementById("filePick");
const pickDirEl = document.getElementById("pickDir");
const touchNoteEl = document.getElementById("touchNote");
const dropTitleEl = document.getElementById("dropTitle");
const statusEl = document.getElementById("status");
const stateEl = document.getElementById("state");
const statsEl = document.getElementById("stats");
const dotEl = document.getElementById("dot");
const shareEl = document.getElementById("share");
const urlEl = document.getElementById("url");
const copyEl = document.getElementById("copy");
const openEl = document.getElementById("open");
const filesEl = document.getElementById("files");
const errorEl = document.getElementById("error");

const client = new WebTorrent();
client.on("error", (err) => fail(err.message || String(err)));

function fail(msg) {
  console.error(LOG, "error:", msg);
  errorEl.textContent = msg;
  errorEl.hidden = false;
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

function seed(files) {
  if (!files.length) return fail("That folder was empty.");

  const hasIndex = files.some((f) => /(^|\/)index\.html$/i.test(f.fullPath || f.name));
  if (!hasIndex) {
    fail("No index.html found in that folder. The site needs an entry page.");
    return;
  }

  // Torrent name = the dropped folder's name, when there is a common root.
  const first = (files[0].fullPath || files[0].name).split("/");
  const name = files.length && first.length > 1 ? first[0] : undefined;

  const total = files.reduce((n, f) => n + f.size, 0);
  console.log(LOG, `seeding ${files.length} files, ${formatBytes(total)}`);

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

  client.seed(files, { name, announce: TRACKERS }, (torrent) => {
    console.log(LOG, "seeding", torrent.infoHash, torrent.magnetURI);
    const url = shareUrl(torrent.infoHash);
    urlEl.value = url;
    openEl.href = url;
    shareEl.hidden = false;
    dotEl.classList.add("is-live");
    stateEl.textContent = "Seeding";

    const tick = () => {
      statsEl.textContent = `${torrent.numPeers} peer${torrent.numPeers === 1 ? "" : "s"} · ` +
        `${formatBytes(torrent.uploaded)} sent · ${formatBytes(torrent.length)} total`;
    };
    tick();
    torrent.on("upload", tick);
    torrent.on("wire", () => {
      console.log(LOG, "peer connected, now", torrent.numPeers);
      tick();
    });
    setInterval(tick, 2000);
  });
}

// Warn before the tab closes, because closing it kills the site.
addEventListener("beforeunload", (e) => {
  if (client.torrents.length) {
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
  try {
    seed(await filesFromDataTransfer(e.dataTransfer));
  } catch (err) {
    fail(err.message || String(err));
  }
});

// Directory pickers do not exist on Android or iOS: `webkitdirectory` is desktop-only, so
// that control would simply do nothing there. Detect a touch device and hide it rather than
// leave a dead button, steering to the files picker instead.
const isTouch = matchMedia("(pointer: coarse)").matches;
if (isTouch) {
  pickDirEl.hidden = true;
  touchNoteEl.hidden = false;
  dropTitleEl.textContent = "Pick the files for your site";
  console.log(LOG, "touch device: no folder picker, offering files instead");
}

// Clicking the zone opens the folder picker on desktop, but never swallow clicks that are
// already headed for a real <label>, or we would open and immediately re-open the dialog.
dropEl.addEventListener("click", (e) => {
  if (isTouch || e.target.closest("label, input")) return;
  dirEl.click();
});

for (const input of [dirEl, filesInputEl]) {
  input.addEventListener("change", () => {
    if (!input.files.length) return;
    errorEl.hidden = true;
    seed(filesFromInput(input.files));
  });
}

copyEl.addEventListener("click", async () => {
  await navigator.clipboard.writeText(urlEl.value);
  const label = copyEl.querySelector("span");
  label.textContent = "Copied";
  setTimeout(() => (label.textContent = "Copy"), 1400);
});

console.log(LOG, "drop page ready");
