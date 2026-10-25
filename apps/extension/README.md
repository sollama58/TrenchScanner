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
  and only to `api.trenchscanner.app/ext/v1`. It answers the extension's own pages, and
  TrenchScanner's site (`externally_connectable`) for the one-click key hand-over.
- `src/panel/` is the side panel: the alerts list (`card.ts`), Trade Buddy (`buddy.ts`) and the
  settings, which are saved to the account. The toolbar icon or Alt+Shift+T opens it.
- **Bubble maps** (`bubble.ts`, 0.3.0): a click on an alert opens its latest bubble map, with the
  site's category totals (Linked, KOL bundled, Bundled, Same minute, CEX-funded, Tied to dev,
  Transferred, Top 10, and the wallet types). The API's `/ext/v1/bubble/:mint` serves the site's
  reading (`apps/api/src/extensionBubble.ts`) and keeps the map watched while it is open, as the
  site's token view does, so the worker keeps those holders current. Re-read every 30 s.
- **Trade Buddy** (`buddy.ts`, 0.3.0): the coins the account's own wallet bought, from any venue,
  followed as the site's TRADES panel follows them (`/ext/v1/buddy`, `apps/api/src/extensionBuddy.ts`),
  each with its token card, bubble map (held coins open by default) and PnL. Pro Mode accounts get a
  trade box per coin, collapsed by default. It holds no wallet and sends nothing: each button opens
  `trenchscanner.app/?trade=<mint>&buy=<SOL>` (or `&sell=<percent>`), which opens the coin with its
  Trade panel filled in (`apps/web/src/tradeLink.ts`), and the wallet signs there.

## Version rule

**Every change to `apps/extension` bumps its version** (user rule 2026-10-24): `version` in
`static/manifest.json` and in `package.json`, the same in both. CI fails a pull request that changes
the extension without a higher version (`scripts/check-extension-version.sh`), and the build fails
when the two differ. Patch for fixes, minor for features. The Chrome Web Store also refuses an upload
whose version isn't higher than the last.

## Try it

```sh
npm run build -w @trenchscanner/extension
```

Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick
`apps/extension/dist`. The dev build carries `dev-key.pub`, so the unpacked extension's ID is always
`jhdfdijmhnomcdijohdfibelodhfiigl`. TrenchScanner's Settings knows that ID
(`apps/web/src/extensionBridge.ts`), so in the panel, **Connect with TrenchScanner** then
**Connect this browser** connects it in one click. The link carries the extension's own ID, so a
build whose ID isn't listed there (the store zip loaded unpacked) connects too. There is no key to paste.
Keys need paid access. AI verdicts appear for admin wallets only, as on the site.

## Release to the Chrome Web Store

```sh
npm run package -w @trenchscanner/extension   # release/trench-overlay-<version>.zip
```

The store build leaves out `dev-key.pub`, because the store assigns its own ID. After the first
upload, add that ID to `STORE_IDS` in `apps/web/src/extensionBridge.ts` (or `VITE_EXTENSION_IDS` on
the web service). Until then, store installs connect through the ID their link carries. The listing's text, permission
justifications and privacy answers are in `STORE.md`, and the privacy policy is
`https://trenchscanner.app/extension-privacy.html` (`apps/web/public/extension-privacy.html`).

Permissions are `storage` and `sidePanel`, plus the API host. None of them shows an install warning.

## Rings build (local only, never uploaded)

The `local/rings` branch brings back the in-page rings dropped on 2026-10-23, for the owner's own
browser (user ask 2026-10-24): a content script (`src/content/`) on Axiom, Terminal and GMGN rings
the rows of tokens in the reader's alert feed, with the model or filter badge and a red dot past a
flag's limit. It holds no key and sends no address anywhere: the service worker answers from the
panel's own feed (`handleContent` in `sw.ts`), so tokens outside your alerts are never asked about.
Its trade-off is the one that dropped it: code running in those sites' pages. Not for the store.

The ring tooltip is the reader's to set (Settings → Ring tooltip, user ask 2026-10-25): each line
on or off and in any order, kept in this browser only (`src/shared/tooltip.ts`). The default is
the original tooltip plus KOL bundled %. Map lines (KOL bundled and the other bubble map totals)
are read on hover with the panel's `/bubble/:mint` call, and only for a coin already in the
reader's alerts, so this still sends no address the panel wouldn't.

The ring's pill is set the same way (Settings → Ring pill): which parts it shows and their order,
and the red dot. Settings → Second pill adds a dashed pill beside it with more of the coin's
numbers, off by default, placed in the next free patch of the row and left out when none fits.
