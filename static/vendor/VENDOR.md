# Vendored WebTorrent

`webtorrent.min.js` and `sw.min.js` are copied from `webtorrent@3.0.16`
(`dist/webtorrent.min.js`, `dist/sw.min.js`). They must be served same-origin
(the service worker can only claim scope on its own origin), so they are vendored
rather than loaded from a CDN. `webtorrent.min.js` is an **ES module** (default
export) — import it, do not load it via a classic `<script>` tag.

## Local patch (must be reapplied after re-vendoring)

WebTorrent's in-page server serves every file with
`Content-Security-Policy: base-uri 'none'; frame-ancestors 'none'; form-action 'none';`.
The `frame-ancestors 'none'` blocks our viewer from rendering the site in an iframe,
which is the whole architecture. We relax it to `'self'` — same-origin framing is
allowed (our viewer and the served files share the `<infohash>.unhosted.dev` origin),
cross-origin framing is still blocked:

    sed -i "s/frame-ancestors 'none'/frame-ancestors 'self'/" webtorrent.min.js
