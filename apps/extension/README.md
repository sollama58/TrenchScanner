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
- `src/panel/` is the side panel: the alerts list (`card.ts`) and the settings, which are saved to
  the account. The toolbar icon or Alt+Shift+T opens it.

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
