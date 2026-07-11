// Examples gallery + inline IDE for unhosted.dev.
//
// The gallery lists example sites (static sources under /examples). "Share" seeds an example as
// a site; "Remix" opens it in the IDE. The IDE is a multi-file editor with a sandboxed live
// preview and a Host button that hands the in-memory files to app.js's __unhostedHost — the same
// seed → register flow a dropped folder uses. Editing changes the content, and the content is
// the address, so each Host mints a new infohash (the URL changes); the note in the UI says so.

const LOG = "[ide]";

const galleryEl = document.getElementById("gallery");
const examplesEl = document.getElementById("examples");
const ide = document.getElementById("ide");
const fileListEl = document.getElementById("ideFileList");
const codeEl = document.getElementById("ideCode");
const previewEl = document.getElementById("idePreview");
const titleEl = document.getElementById("ideTitle");
const dropzoneEl = document.getElementById("ideDropzone");

/** @type {{path:string, content:string|Blob, binary?:boolean, dataUri?:string}[]} */
let files = [];
let active = 0;
let previewTimer = 0;

// ---- Gallery --------------------------------------------------------------------------------

async function loadGallery() {
  try {
    const res = await fetch("/examples/manifest.json");
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const { examples } = await res.json();
    galleryEl.replaceChildren(...examples.map(card));
    examplesEl.hidden = false;
  } catch (err) {
    console.warn(LOG, "gallery unavailable:", err);
  }
}

function card(ex) {
  const el = document.createElement("article");
  el.className = "card";

  const thumb = document.createElement("div");
  thumb.className = "card__thumb";
  const frame = document.createElement("iframe");
  frame.className = "card__preview";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("loading", "lazy");
  frame.setAttribute("tabindex", "-1");
  frame.setAttribute("aria-hidden", "true");
  frame.src = `/examples/${ex.slug}/index.html`;
  thumb.append(frame);

  const body = document.createElement("div");
  body.className = "card__body";
  const h3 = document.createElement("h3");
  h3.textContent = ex.title;
  const p = document.createElement("p");
  p.textContent = ex.blurb;
  const actions = document.createElement("div");
  actions.className = "card__actions";

  const share = document.createElement("button");
  share.type = "button";
  share.className = "btn btn--primary btn--sm";
  share.textContent = "Share this";
  share.addEventListener("click", () => shareExample(ex));

  const remix = document.createElement("button");
  remix.type = "button";
  remix.className = "btn btn--sm";
  remix.textContent = "Remix";
  remix.addEventListener("click", () => remixExample(ex));

  actions.append(share, remix);
  body.append(h3, p, actions);
  el.append(thumb, body);
  return el;
}

async function fetchExample(ex) {
  const out = [];
  for (const name of ex.files) {
    const res = await fetch(`/examples/${ex.slug}/${name}`);
    out.push({ path: name, content: await res.text() });
  }
  return out;
}

async function shareExample(ex) {
  const specs = (await fetchExample(ex)).map((f) => ({ path: f.path, content: f.content }));
  globalThis.__unhostedHost(specs);
}

async function remixExample(ex) {
  openIde(await fetchExample(ex), ex.title);
}

// ---- IDE ------------------------------------------------------------------------------------

const STARTER = [{
  path: "index.html",
  content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>My site</title>
    <style>
      body { font: 16px/1.6 system-ui, sans-serif; display: grid; place-items: center;
        min-height: 100dvh; margin: 0; background: #0b0d12; color: #f2f5fa; }
      h1 { font-size: 3rem; }
    </style>
  </head>
  <body>
    <h1>Hello 👋</h1>
    <script>
      // your code here
    </script>
  </body>
</html>
`,
}];

function openIde(initial, title) {
  files = initial.map((f) => ({ ...f }));
  active = 0;
  titleEl.textContent = title || "New project";
  ide.hidden = false;
  document.body.style.overflow = "hidden";
  renderFileList();
  loadActiveIntoEditor();
  refreshPreview();
  codeEl.focus();
}

function closeIde() {
  ide.hidden = true;
  document.body.style.overflow = "";
}

function renderFileList() {
  fileListEl.replaceChildren(...files.map((f, i) => {
    const li = document.createElement("li");
    li.className = "ide__file" + (i === active ? " is-active" : "");

    const name = document.createElement("button");
    name.type = "button";
    name.className = "ide__filename";
    name.textContent = f.path;
    name.addEventListener("click", () => selectFile(i));
    name.addEventListener("dblclick", () => beginRename(i, name));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "ide__filedel";
    del.textContent = "×";
    del.title = "Delete file";
    del.setAttribute("aria-label", `Delete ${f.path}`);
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteFile(i);
    });

    li.append(name, del);
    return li;
  }));
}

function selectFile(i) {
  commitEditor();
  active = i;
  renderFileList();
  loadActiveIntoEditor();
}

function loadActiveIntoEditor() {
  const f = files[active];
  if (f.binary) {
    codeEl.value =
      `[binary file: ${f.path}]\nThis file will be hosted as-is; it isn't text-editable here.`;
    codeEl.readOnly = true;
  } else {
    codeEl.value = typeof f.content === "string" ? f.content : "";
    codeEl.readOnly = false;
  }
}

function commitEditor() {
  const f = files[active];
  if (f && !f.binary) f.content = codeEl.value;
}

function uniqueName(base) {
  if (!files.some((f) => f.path === base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = 1;
  while (files.some((f) => f.path === `${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

function addFile() {
  commitEditor();
  const path = uniqueName("new-file.js");
  files.push({ path, content: "" });
  active = files.length - 1;
  renderFileList();
  loadActiveIntoEditor();
  // Immediately let the user rename it.
  const nameBtn = fileListEl.children[active]?.querySelector(".ide__filename");
  if (nameBtn) beginRename(active, nameBtn);
}

function deleteFile(i) {
  if (files.length === 1) return; // keep at least one file
  files.splice(i, 1);
  if (active >= files.length) active = files.length - 1;
  else if (i < active) active--;
  renderFileList();
  loadActiveIntoEditor();
  schedulePreview();
}

function beginRename(i, nameBtn) {
  const input = document.createElement("input");
  input.className = "ide__rename";
  input.value = files[i].path;
  input.spellcheck = false;
  nameBtn.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    let v = input.value.trim().replace(/^\/+/, "");
    if (!v) v = files[i].path;
    if (v !== files[i].path && files.some((f, j) => j !== i && f.path === v)) v = uniqueName(v);
    files[i].path = v;
    renderFileList();
    if (i === active) loadActiveIntoEditor();
    schedulePreview();
  };
  input.addEventListener("blur", commit, { once: true });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
      input.value = files[i].path;
      input.blur();
    }
  });
}

// ---- Live preview (sandboxed, inlined) ------------------------------------------------------

function findFile(ref) {
  const norm = ref.replace(/^\.?\//, "");
  const base = norm.split("/").pop();
  return files.find((f) => f.path === norm) || files.find((f) => f.path.split("/").pop() === base);
}

function textOf(f) {
  return typeof f.content === "string" ? f.content : "";
}

/** Assemble a single self-contained HTML document so it renders inside a same-origin-less iframe. */
function buildPreviewDoc() {
  commitEditor();
  const index = files.find((f) => /(^|\/)index\.html?$/i.test(f.path));
  if (!index) {
    return `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui,sans-serif;` +
      `color:#8b96ad;background:#0b0d12;display:grid;place-items:center;height:100vh;margin:0">` +
      `Add an <code>index.html</code> to see a preview.</body>`;
  }
  let html = textOf(index);

  // Inline <link rel=stylesheet href="local.css"> → <style>…</style>
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const m = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!m) return tag;
    const f = findFile(m[1]);
    if (f && /\.css$/i.test(f.path)) return `<style>\n${textOf(f)}\n</style>`;
    return tag;
  });

  // Inline <script src="local.js"></script> → <script>…</script>
  html = html.replace(
    /<script\b[^>]*?\ssrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (tag, src) => {
      const f = findFile(src);
      if (f && /\.(m?js)$/i.test(f.path)) return `<script>\n${textOf(f)}\n</script>`;
      return tag;
    },
  );

  // Rewrite local image/media refs to data URIs (for dropped binary files).
  html = html.replace(/(\s(?:src|href)\s*=\s*["'])([^"']+)(["'])/gi, (m, pre, ref, post) => {
    const f = findFile(ref);
    if (f && f.dataUri) return pre + f.dataUri + post;
    return m;
  });

  return html;
}

function refreshPreview() {
  previewEl.srcdoc = buildPreviewDoc();
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 450);
}

// ---- Host -----------------------------------------------------------------------------------

function hostFromIde() {
  commitEditor();
  const specs = files.map((f) => ({ path: f.path, content: f.content }));
  closeIde();
  globalThis.__unhostedHost(specs);
}

// ---- Drag & drop into the IDE ---------------------------------------------------------------

const TEXT_EXT = /\.(html?|css|m?js|json|svg|txt|md|xml|csv|webmanifest)$/i;

async function addDroppedFiles(fileList) {
  commitEditor();
  for (const file of fileList) {
    const path = uniqueName(file.name);
    if (TEXT_EXT.test(file.name)) {
      files.push({ path, content: await file.text() });
    } else {
      const dataUri = await blobToDataUri(file);
      files.push({ path, content: file, binary: true, dataUri });
    }
  }
  active = files.length - 1;
  renderFileList();
  loadActiveIntoEditor();
  refreshPreview();
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ---- Wiring ---------------------------------------------------------------------------------

document.getElementById("newProject").addEventListener(
  "click",
  () => openIde(STARTER, "New project"),
);
document.getElementById("ideClose").addEventListener("click", closeIde);
document.getElementById("ideAddFile").addEventListener("click", addFile);
document.getElementById("ideHost").addEventListener("click", hostFromIde);
document.getElementById("ideRefresh").addEventListener("click", refreshPreview);

codeEl.addEventListener("input", () => {
  files[active].content = codeEl.value;
  schedulePreview();
});

// Tab inserts two spaces instead of moving focus.
codeEl.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const s = codeEl.selectionStart, en = codeEl.selectionEnd;
  codeEl.value = codeEl.value.slice(0, s) + "  " + codeEl.value.slice(en);
  codeEl.selectionStart = codeEl.selectionEnd = s + 2;
});

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !ide.hidden && document.activeElement !== codeEl) closeIde();
});

let dragDepth = 0;
ide.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  dropzoneEl.hidden = false;
});
ide.addEventListener("dragover", (e) => e.preventDefault());
ide.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropzoneEl.hidden = true;
  }
});
ide.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzoneEl.hidden = true;
  if (e.dataTransfer?.files?.length) addDroppedFiles(e.dataTransfer.files);
});

loadGallery();
