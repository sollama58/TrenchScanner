# Trench Overlay

A Chrome side panel of your TrenchScanner alerts, to keep open beside Axiom, Terminal or GMGN.
Each alerted token shows its model calls, filter matches, the AI's verdict and the stat flags you
pick, with links that open it on those sites. The design is in the project's plan
(notes/chrome-overlay-2026-10-23).

**Since 0.4.0 it runs on Axiom, Terminal and GMGN** to ring your alerts in their boards (Rings,
below; user decision 2026-10-25, reversing the 2026-10-23 one for the owner's own use). The
store build has none of it: `npm run package` (`build.mjs --store`, below) leaves out everything
that runs in a website's page, because `STORE.md`'s answers say the extension never does. Otherwise there is no host
access beyond `api.trenchscanner.app`, and no `tabs`, `scripting`, `cookies` or `webRequest`.

- `src/sw.ts` is the service worker: the only part that holds the key or talks to the network,
  and only to `api.trenchscanner.app/ext/v1`. It answers the extension's own pages, and
  TrenchScanner's site (`externally_connectable`) for the one-click key hand-over.
- `src/panel/` is the side panel: the alerts list (`card.ts`), Trade Buddy (`buddy.ts`) and the
  settings, which are saved to the account. The toolbar icon or Alt+Shift+T opens it.
- **Bubble maps** (0.6.0, user ask 2026-10-25): the site's own map, so it looks and acts the same
  (clusters, KOLs, transfers, CEX links, risky rings, wallet names, zoom, the Holders switch and
  its moments). The site's code is bundled in (`apps/web/src/components/TokenMapView.tsx` through
  `apps/web/src/embed/tokenMapEmbed.tsx`, with React; `src/map/siteMap.ts`), in a shadow root of
  its own in the panel. Every API call it makes goes to the worker, which sends it to
  `POST /ext/v1/site`: the API replays it as the key's owner only if it is one of the map's own
  reads for a coin (`apps/api/src/extensionSite.ts`), so the key reaches nothing else on the site.
  It follows the coin live as the token view does (the holder wait, the top 50, the live trades),
  and keeps the coin watched and scanned while open. A wallet it opens opens on TrenchScanner.
  `/ext/v1/bubble/:mint` (`apps/api/src/extensionBubble.ts`) still serves the tooltip's map lines.
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

The store build (user ask 2026-10-25) has nothing that runs in a website's page: no content
script (rings, pills, on-page alerts, the safety screen on the boards, the bubble map tab and the
holder markers), no `web_accessible_resources` and no `map.html` for the map tab's frame, and the
store summary as the manifest's description. The code reads `__STORE__` (true only there): the
panel's Settings drops the ring, pill, tooltip, alert, safety, coin-page and per-model sections and
keeps the panel's own colours, the Account note says it never runs on a website, and the worker
answers no page. The dev build (`npm run build`) keeps all of it.

The store build also leaves out `dev-key.pub`, because the store assigns its own ID. After the first
upload, add that ID to `STORE_IDS` in `apps/web/src/extensionBridge.ts` (or `VITE_EXTENSION_IDS` on
the web service). Until then, store installs connect through the ID their link carries. The listing's text, permission
justifications and privacy answers are in `STORE.md`, and the privacy policy is
`https://trenchscanner.app/extension-privacy.html` (`apps/web/public/extension-privacy.html`).

Permissions are `storage`, `sidePanel`, `alarms` and `notifications`, plus the API host. Only
`notifications` shows an install warning ("Display notifications").

## Rings (0.4.0 and later, not in the store)

The in-page rings dropped on 2026-10-23 are back, for the owner's own browser (user asks
2026-10-24 and 2026-10-25): a content script (`src/content/`) on Axiom, Terminal and GMGN rings
the rows of tokens in the reader's alert feed, with the model or filter badge and a red dot past a
flag's limit. It holds no key and sends no address anywhere: the service worker answers from the
panel's own feed (`handleContent` in `sw.ts`), so tokens outside your alerts are never asked about.
Its trade-off is the one that dropped it: code running in those sites' pages. It reads each row's
address (Axiom's Pulse marks and Discover's pump.fun links, Terminal's Trenches marks and Trending
copy buttons, GMGN's token links; `src/content/adapters/sites.ts`) and nothing else.

The store build leaves all of this out (Release to the Chrome Web Store, above).

The ring tooltip is the reader's to set (Settings → Ring tooltip, user ask 2026-10-25): each line
on or off and in any order, kept in this browser only (`src/shared/tooltip.ts`). The default is
the original tooltip plus KOL bundled %. Map lines (KOL bundled and the other bubble map totals)
are read on hover with the panel's `/bubble/:mint` call, and only for a coin already in the
reader's alerts, so this still sends no address the panel wouldn't.

The ring's pill is set the same way (Settings → Ring pill): which parts it shows and their order,
and the red dot. Settings → Second pill adds a dashed pill beside it with more of the coin's
numbers, off by default, placed in the next free patch of the row and left out when none fits.

## On-page tools (0.5.0, not in the store)

Colors are the reader's (Settings → Colours, user ask 2026-10-25): the ring, pill, risk, tooltip
and panel colors, each a plain `#rrggbb`, kept in this browser only and applied as CSS variables
in each shadow root. The second pill no longer flickers: where a pill was placed is kept apart
from what it says, so a redraw does not move it, and it stays put while it still fits.

Alert toasts (Settings → On-page alerts) put a small card on the page when a new alert lands in the
reader's feed. They are off by default. Everything about them is the reader's: which models and
filters, the lowest odds, AI buys only, the corner, how long a card stays (0 keeps it), how many
show at once, a chime, what a click does (open the coin on the site, on TrenchScanner, or
nothing), which sites show them, and what the card says. They read the panel's own feed through
the worker (`{type: "alerts"}`), every 10s while the tab is visible, and the first read only marks
what is already there.

Bubble map tab (Settings → Bubble map tab, on by default): on a coin's own page (Axiom
`/meme/…`, Terminal `/trade/solana/…`, GMGN `/sol/token/…`) a "Bubble map" tab is added beside
the site's Top Traders tab and opens the site's map in a box on the page (`src/content/mapTab.ts`).
The map runs in a frame of the extension's own page (`map.html`, `src/map/page.ts`, a web
accessible resource with a per-session URL), so none of its code or reads runs in the site's page,
and the worker answers that frame's reads only while the tab is on. Unlike the rings, this sends
the viewed coin's address to TrenchScanner, alerted or not; turn it off to stop that.

0.5.2: links back to TrenchScanner open the coin's token view (`?token=<mint>`, read by the site's
`tradeLink.ts`) rather than TokenSage, and an on-page alert shows once per coin, whichever models
or filters call it later.

0.7.0 (user asks 2026-10-25):

- **Safety screen on the boards** (Settings → Safety screen on the boards, off by default): a coin
  whose newest TrenchScanner scan fails the safety screen is hidden, or marked with an X and the
  screen's reasons on hover, and shows again once a scan passes it. The reader picks the columns it
  applies to: New, About to graduate, Graduated, and Trending and other lists
  (`src/content/columns.ts`: Terminal's row marks, else the column headings). Coins TrenchScanner
  never scanned stay as they are. Unlike the rings, this sends the board's addresses to
  TrenchScanner (`POST /ext/v1/safety`, database only, the verdict the same for every reader), and
  only while it is on. It is not used on a coin's own page.
- **Holder markers** (Settings → On a coin's page, on by default): on a coin's page, each wallet the
  page names that is among the coin's top holders on the bubble map gets a chip (its cluster,
  same-minute funding, sniper, fresh, block zero or empty wallet, CEX funding, dev ties); a chip
  opens the Bubble map tab (`src/content/holderMarks.ts`). Wallets are found by links naming them in
  full or by text that is the address or a short form only one holder fits, so it marks them in the
  holders list and anywhere else on the page. It reads the viewed coin's map, as the tab does.
- **Each model and filter** (Settings → Each model and filter): its own ring colour and an extra
  effect (pulse, strong glow, shimmer, sparkle, flash), for the models and filters in the feed.
- The map's time: one "Updated …" stamp, in the holders bar, counting the live trades that move the
  shares, and "Now" reads "Latest".

0.7.1: the display choices (Settings' tooltip, pills, colours, on-page alerts, safety screen,
coin-page tools, each model's and filter's ring) are kept with the account too (`PUT
/ext/v1/look`, read back in `/me`), so a reinstall or another browser gets them back once it
connects (user ask 2026-10-25). The newer save wins, this browser's or the account's
(`syncLook` in `sw.ts`); the account's settings (rings, flags, sites, style) already were.

0.7.2 (user ask 2026-10-25):

- The failing-safety mark is minimal: a thin red edge and a small "✕ Unsafe" tag in the row's
  corner, with no dimming. Hovering the tag shows why it fails, and the ring's tooltip has a
  "Safety screen" line (on by default) saying Passed or Failed and why.
- A hidden coin leaves no gap: on virtual-scrolling lists (rows placed by `top` or `translateY`)
  its slot is made invisible and the rows below it move up by its height (`closeGaps` in
  `engine.ts`); elsewhere the row is taken out with `display: none`.

0.7.3: `npm run package` makes the store build with nothing on the sites' pages and none of their
settings (Release to the Chrome Web Store, above; user ask 2026-10-25).

0.8.0: the panel makes up for what the store build leaves out (user asks 2026-10-25), in both builds:

- **Safety on each card:** the safety screen's verdict on the coin's newest scan, Passed or Failed
  and why. Settings → Alerts can hide the failing ones (off by default); they come back once a
  scan passes them.
- **Look up:** a tab that takes any coin's address, or a link with one, and shows its card, the
  site's bubble map and its top 20 holders tagged as the holder markers tag them
  (`src/panel/coin.ts`, `src/shared/holders.ts`). The card comes from the new `GET
/ext/v1/token/:mint` (database only, as the feed answers its tokens).
- **Notifications and the icon's count** (Settings → Alerts): a Chrome notification for each new
  alert (off by default; a click opens the coin on TrenchScanner), and the count of alerts the
  panel hasn't shown on the toolbar icon (on by default). The worker reads the feed once a minute
  for them, only while one is on (`noteAlerts` in `sw.ts`); the first read only marks what is there.
- **Each model's and filter's colour** on its cards in the panel too; the store build's Settings
  keeps that section, without the ring effects.

0.8.1 (user asks 2026-10-26):

- **Empty wallets in top 10** is a flag (off by default, limit 3), so the pill, the tooltip and the
  panel can show it: how many of the top 10 holders hold nothing else worth $25. The scan
  re-measures it each cycle against the current top 10; the API answers the newest reading, or the
  last known one (`Token.lastEmptyTop10WalletPct`) when the newest scan's lookups didn't all land.
- The unsafe mark tints the failing coin's row red, and its "✕ Unsafe" tag is a size larger.

0.8.2 (user ask 2026-10-26): rings and safety marks follow a scroll. A lookup goes out within
30 ms of rows changing and every 120 ms while they keep changing, where it waited for the page to
settle for 300 ms before (so a long scroll got nothing until it stopped). It asks about every row
the page has rendered, those on screen first, so a virtual list's rows past the edge are answered
before they scroll in; the worker answers from its last feed read (up to two minutes old) at once
while a fresh read runs behind it. The safety screen's asks, which reach TrenchScanner, go out at
most every 600 ms and never twice for a coin already being asked about.

0.8.3 (user ask 2026-10-26): **Pill on every coin** (Settings → Pill on every coin, off by
default). Coins that aren't the reader's alerts get the ring pill's parts too, as a grey pill with
no ring and the same tooltip, wherever TrenchScanner has numbers no older than the reader's limit
(30 minutes by default, 1 to 1440). Their numbers come from `POST /ext/v1/stats` (the lookup's
shared half: no one's calls, matches or AI review), asked only while the option is on and at most
every 600 ms, so like the safety screen it sends the board's addresses to TrenchScanner.

0.8.4: a board pill no longer shows as a bare dot. The pill's default parts (model or filter
name, odds) and the change and age parts only exist for an alert, so a board coin came out empty
and drew the dot alone. A board coin's pill now holds whatever numbers the reader's two pills
have, in one pill, or market cap and holders when none of them does; with nothing to say, or no
room for its label, it gets no pill.

0.8.5 (user ask 2026-10-26): a pill no longer shrinks to its dot. Where the whole label fits in
no free space on the card, it drops parts from the end until it does (the first ones, the model's
name and odds by default, are kept); where even the first part fits nowhere, it goes in the card's
visible top-right corner over the content. A card wider than the column showing it no longer has
its pill placed in the part the column cuts off, which left only the dot in view.
