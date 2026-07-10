// Client telemetry for webtorrent-drop. Captures errors, unhandled rejections, and named
// lifecycle/timing events, batches them, and flushes to /_beacon with navigator.sendBeacon
// (which survives page unload). The server stores them in KV; inspect at /_admin.
//
// Data hygiene: we send diagnostic SHAPE, not user content. Infohashes are the public
// address of a site so they are fine; dropped file *names* and page content are not sent.
// Keep it that way when adding events.

const ENDPOINT = "/_beacon";
const FLUSH_MS = 4000;
const MAX_BATCH = 20;

// A random per-page-load id ties an error to the session that produced it without
// identifying the user. sessionStorage would persist across reloads; we deliberately do not.
const sid = (crypto.randomUUID?.() ?? String(Math.random())).slice(0, 8);
const page = location.pathname === "/" ? "drop" : "viewer";

const queue = [];
let timer = null;

function flush() {
  timer = null;
  if (!queue.length) return;
  const batch = queue.splice(0, queue.length);
  try {
    const blob = new Blob([JSON.stringify(batch)], { type: "application/json" });
    // sendBeacon returns false if it could not queue; fall back to a keepalive fetch.
    if (!navigator.sendBeacon || !navigator.sendBeacon(ENDPOINT, blob)) {
      fetch(ENDPOINT, { method: "POST", body: blob, keepalive: true }).catch(() => {});
    }
  } catch {
    // Never let telemetry throw into app code.
  }
}

function schedule() {
  if (queue.length >= MAX_BATCH) return flush();
  timer ??= setTimeout(flush, FLUSH_MS);
}

/**
 * Record an event. `event` is a short stable name; `data` is a small plain object of
 * diagnostic fields (numbers, short strings, booleans). No user content.
 */
export function track(event, data = {}) {
  queue.push({
    event,
    page,
    sid,
    t: Math.round(performance.now()),
    ...data,
  });
  schedule();
}

// Uncaught errors and promise rejections — the things that made the page do nothing.
addEventListener("error", (e) => {
  // Resource load errors (e.target is an element) vs script errors (e.message present).
  if (e.message) {
    track("error", {
      msg: String(e.message).slice(0, 300),
      src: (e.filename ?? "").split("/").pop(),
      line: e.lineno,
      col: e.colno,
      stack: e.error?.stack?.split("\n").slice(0, 4).join(" | ").slice(0, 500),
    });
  } else if (e.target && e.target.src) {
    track("resource-error", { url: String(e.target.src).slice(0, 200) });
  }
}, true);

addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  track("unhandledrejection", {
    msg: String(r?.message ?? r).slice(0, 300),
    stack: r?.stack?.split("\n").slice(0, 4).join(" | ").slice(0, 500),
  });
});

// Environment snapshot, once, so we can correlate failures with capability. WebTorrent is
// an ES module imported by app/viewer, not a global, so it is not detectable from here.
track("pageview", {
  ua: navigator.userAgent.slice(0, 200),
  sw: "serviceWorker" in navigator,
  secure: isSecureContext,
  rtc: typeof RTCPeerConnection !== "undefined",
  dpr: devicePixelRatio,
  vw: innerWidth,
});

// Flush on the way out, and when a background tab is hidden (mobile may never fire unload).
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});
addEventListener("pagehide", flush);

console.log("[wt-drop] telemetry active, session", sid);
