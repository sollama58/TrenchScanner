# Trench Overlay

A Chrome side panel of your TrenchScanner alerts, to keep open beside Axiom, Terminal or GMGN.
Each alerted token shows its model calls, filter matches, the AI's verdict and the stat flags you
pick, with links that open it on those sites. The design is in the project's plan
(notes/chrome-overlay-2026-10-23).

**It never runs on a trading site.** No content scripts, no host access beyond
`api.trenchscanner.app`, no `tabs`, `scripting`, `cookies` or `webRequest`. Code inside a site's
page can read that site's logins, and Chrome has no draw-only sandbox, so the in-page rings were
dropped (user decision 2026-10-23): nothing this extension ships, or a bad update of it, can see
those pages. A link is the only thing that leads there.

- `src/sw.ts` is the service worker: the only part that holds the key or talks to the network,
  and only to `api.trenchscanner.app/ext/v1`. It answers the extension's own pages only.
- `src/panel/` is the side panel: the alerts list (`card.ts`) and the settings, which are saved to
  the account. The toolbar icon or Alt+Shift+T opens it.

## Try it

```sh
npm run build -w @trenchscanner/extension
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick
`apps/extension/dist`. Connect with a key from Settings > Browser extension (admins only until
the store listing).

Permissions are `storage` and `sidePanel`, plus the API host. Neither shows an install warning.
