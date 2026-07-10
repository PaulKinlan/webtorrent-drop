# webtorrent-drop

Drop a folder in your browser. It becomes a website, seeded from your tab over
[WebTorrent](https://webtorrent.io). You get a link. **Nothing is uploaded** — this server never
sees, stores, or serves your files. It only ever serves the app.

The site lives while someone is seeding it. Close the last tab and it is gone. That is the point:
ephemeral by design.

> Prototype. Working name.

## Run it

```sh
deno task dev
# http://localhost:8000
```

Service workers need a secure context, so `localhost` or HTTPS.

## How it works

1. You drop a folder. The browser builds a torrent from it (`client.seed`), producing an
   **infohash**, and starts seeding over WebRTC.
2. You get a share link containing that infohash.
3. A visitor opens the link. **This server** answers the TLS handshake and returns a bootstrap page
   plus a service worker. That is the one unavoidable server touch, and the bytes it serves are the
   same for every site.
4. The bootstrap joins the swarm for that infohash, and WebTorrent stands up an in-page HTTP server
   (`client.createServer({ controller })`). The service worker intercepts requests under
   `/webtorrent/<infohash>/…` and streams the pieces out of the swarm.
5. The page renders in an iframe. The visitor's tab now seeds too, while it is open.

The viewer renders the site in an **iframe** rather than navigating to it. The service worker
answers requests by messaging a _window client_ that holds the running WebTorrent server. If the
page navigated away, that client would be destroyed and the site could not be served.

## Addressing

Two forms, in priority order:

| Form                     | When                                                  |
| ------------------------ | ----------------------------------------------------- |
| `<infohash>.example.com` | A wildcard custom domain is attached. The real thing. |
| `example.com/<infohash>` | Stopgap, used on `*.deno.net` and `localhost`.        |

A 40-character hex infohash is a legal DNS label (the limit is 63), so it drops straight into a
subdomain with no encoding. Deno Deploy supports **wildcard custom domains** with automatically
provisioned Let's Encrypt TLS on the Pro plan, so attaching one lights up the subdomain form with no
code change. Each site then gets its own origin, and with it per-site cookie, storage, and XSS
isolation.

## What "no backend" honestly means here

Not "no server". You cannot serve HTTPS from nowhere: a visitor must receive _something_ over TLS
before any JavaScript can run. What is true is that **no backend touches your content**. There is no
per-site storage and no upload. The server serves one fixed app.

Two always-on pieces remain, and pretending otherwise would be dishonest:

- **This bootstrap server** (Deno Deploy), which serves the app and never your files.
- **A wss tracker**, for WebRTC signalling. Browser peers cannot discover each other without one.
  Deno Deploy cannot host it, because signalling needs persistent WebSocket fan-out between peers
  and stateless isolates do not provide that. Right now this uses WebTorrent's public default
  trackers, which are community-run and periodically down. **Self-hosting a tracker is the single
  biggest reliability win available.**

## Known limits

- **Browser seeding dies with the tab.** There is no background seeding. If you were the only seeder
  and you close the tab, the site is gone. Accepted, by design.
- **Browser peers are WebRTC-only.** A desktop BitTorrent client cannot serve these sites.
- **Public trackers are flaky.** If they are down, peers never find each other.
- **Cold swarm means slow first paint** compared to a CDN.
- Mobile browsers suspend background tabs aggressively, so they are poor seeders.

Durability, if ever wanted, means an HTTPS **web seed** (BEP19) — a plain URL listed in the torrent
that always has the bytes. That is a deliberate step away from pure P2P and is not implemented.

## Status: what is and is not verified

- **Verified:** all server routes, the `Service-Worker-Allowed: /` header, `deno check`, `deno fmt`.
  The service worker's intercept prefix and the in-page server's URL shape
  (`/webtorrent/<infoHash>/<encoded path>`) were both read out of the vendored bundle and match what
  the viewer builds.
- **Not yet verified end-to-end in a browser:** the seed → share → render loop. It needs two real
  tabs and a live tracker. Try it and see.

## Layout

```
server.ts            bootstrap + static serving + infohash routing
static/index.html    the drop page
static/app.js        folder -> torrent -> seed
static/viewer.html   the bootstrap shown at <infohash>.domain or /<infohash>
static/viewer.js     join swarm -> service worker -> render in iframe
static/common.js     trackers, infohash parsing, share URLs
static/vendor/       webtorrent.min.js + sw.min.js (must be same-origin)
```

MIT.

## Telemetry

Client observability, so we can see what real browsers do and fix it later.

- `static/telemetry.js` batches uncaught errors, unhandled rejections, and named lifecycle and
  timing events (`seed-start/ready/first-peer`, `view-start/metadata/no-peers/rendered/
  fail`) and
  flushes them with `navigator.sendBeacon`.
- The server also sets a `Reporting-Endpoints` header, so the browser's Reporting API posts
  deprecation, intervention, and crash reports to `/_report` on its own.
- Both land in Deno KV with a 14-day TTL. Client IPs are truncated to `/16` (v4) or `/48` (v6) at
  the edge, from the connection's `remoteAddr` (Deno Deploy's new platform sends no
  `x-forwarded-for`, and reports IPv4 as `::ffff:a.b.c.d`). We store diagnostic shape, never file
  names or page content, and strip the referer query string.
- Inspect at `GET /_admin`, gated by the `REPORT_ADMIN_TOKEN` env var. Add `&format=json` for raw
  data, `&kind=beacon` or `&kind=report` to filter.
