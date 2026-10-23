# Trench Overlay

The Chrome extension that rings TrenchScanner alerts on Axiom, Terminal and GMGN. The design and
the security rules it follows are in the project's plan (notes/chrome-overlay-2026-10-23).

- `src/content/` runs on the three sites only, in the extension's isolated world. It reads each
  token row's address, draws a ring and a badge in a closed shadow root, and shows one tooltip.
  It holds no key and makes no network calls.
- `src/sw.ts` is the service worker: the only part that holds the key or talks to the network,
  and only to `api.trenchscanner.app/ext/v1`.
- `src/popup/` connects an account (a key from Settings > Browser extension) and edits the
  overlay's settings, which are saved to the account.
- `src/content/adapters/sites.ts` holds each site's selectors. When a site changes its markup,
  this is usually the only file to touch.

## Try it

```sh
npm run build -w @trenchscanner/extension
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick
`apps/extension/dist`. Connect with a key from Settings > Browser extension (admins only until
the store listing).

Permissions are `storage` and the API host. No `tabs`, `cookies`, `scripting` or `webRequest`.
