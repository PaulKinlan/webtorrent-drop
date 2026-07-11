# WebTorrent — what's changed (2021–2026)

The meaty functionality changes, not the chore/dep-bump noise that fills the changelog.

## The big one: v2.0.0 (Jan 2023) — ESM rewrite

This was a full breaking rewrite. Everything after is incremental.

- **ESM-only.** Dropped CommonJS `require()`. You now `import WebTorrent from 'webtorrent'`. Dropped
  Node 12 and 14.
- **Dropped browserify, Buffer, and rusha.** Native `crypto.subtle` for SHA-1, `Uint8Array` instead
  of Node `Buffer`, no bundler dependency. The browser bundle is a proper ES module
  (`webtorrent.min.js`), loaded via `<script type="module">`.
- **W3C-like File API.** Torrent files now mimic the platform `File`/`Blob`: `file.arrayBuffer()`,
  `file.blob()`, `file.stream()` (returns a `ReadableStream`), and `file[Symbol.asyncIterator]`
  (`for await (const chunk of file)`). The old `file.getBuffer()` is gone. This aligns WebTorrent
  files with everything else in the web platform.

## createServer — serve a torrent as a website (v2.0 era)

The feature your `webtorrent-drop` project is built on.

- **`client.createServer({ controller })`** stands up an HTTP server _inside the browser_. A service
  worker (`sw.min.js`) intercepts requests under `/webtorrent/<infohash>/…` and streams pieces out
  of the swarm on demand.
- Range requests are supported (so `<video>` seeking works before the torrent finishes).
- Each file gets a **`streamURL`** property — a real URL you can hand to `<video src>`, `fetch()`,
  or an iframe.
- The Node.js and browser implementations were **unified** into one `createServer` API — same code,
  different transport (Node HTTP server vs service worker).
- `file.streamTo(elem)` is a convenience that pipes a file directly into a
  `<video>`/`<audio>`/`<img>` element.

This is what makes "drop a folder → it becomes a website" possible. Before this, you could only
stream individual files to media elements — you couldn't serve a whole site with its own URL
structure.

## Persistent browser storage (FSA + IndexedDB)

Previously, browser torrents were **memory-only** — close the tab, lose everything.

- Browser torrents now use **File System Access API + IndexedDB** for storage.
- Data **persists across sessions** unless you explicitly destroy the store (on `beforeunload`).
- Users can pick a custom directory via `FileSystemDirectoryHandle` (`storeOpts.rootDir`), retaining
  folder structure on disk.
- Your project is intentionally ephemeral (seeds only while a tab is open), but the capability
  exists if you ever want persistence.

## Discovery & transport additions

These trickled in across v2.x:

- **LSD (Local Service Discovery, BEP14)** — `lsd: true`. Finds peers on the local network. New
  addition to the discovery stack (DHT + tracker + PEX + LSD).
- **NAT-UPnP / NAT-PMP** — `natUpnp` and `natPmp` options (Node.js only). Automatic port mapping so
  Node clients are reachable behind NAT. PMP tried first, UPnP fallback.
- **uTP (BEP29)** — `utp: true`. UDP-based reliable transport as a TCP alternative, better
  congestion control.
- **RC4 encryption** — `secure` option (0=off, 1=handshake only, 2=full payload).

## v3.0.0 (May 2026) — modernization

Mostly a housekeeping major bump, not new features:

- **Node 22+** required.
- bittorrent-protocol v5, bitfield v5, ut_metadata v5 (all internal module major bumps).
- **Allow specifying User-Agent** (`opts`).
- Connection/port exhaustion fixes.
- WebSeed request calculation corrected.

## What hasn't changed (things you might expect but didn't happen)

- **Browser is still WebRTC-only.** No UDP/TCP peers in the browser. Web peers can only talk to
  other WebRTC-capable peers (WebTorrent Desktop, webtorrent-hybrid, Vuze, etc.). Regular BitTorrent
  clients can't connect to browser peers.
- **No WebTransport.** It was discussed but not shipped. WebRTC data channels remain the only
  browser P2P transport.
- **No BEP 52 (v2 torrents).** Still BitTorrent v1 (BEP 3) only. The infohash is SHA-1 of the v1
  info dictionary.

## What this means for webtorrent-drop

Your project sits right on the `createServer` + service worker layer that was the headline v2.0
feature. The ESM import (`webtorrent.v2.min.js`), `client.createServer({ controller })`,
`file.streamURL`, and the service worker request interception are all v2.0 capabilities. Nothing in
v3.0 affects you functionally — it's just Node version bumps and internal module updates.

The main opportunity: if you ever want seeded sites to persist across visits, the FSA+IDB storage
layer now exists — a returning visitor could re-seed from cached pieces without re-downloading. But
that cuts against the ephemeral-by-design ethos.
