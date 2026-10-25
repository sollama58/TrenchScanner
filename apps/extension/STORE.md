> **Upload only `npm run package` output** (README "Release to the Chrome Web Store"): it has no content script or in-page frame, so the answers below, which say the extension never runs on a website, hold. The dev build (`npm run build`) carries the rings and must never be uploaded.

# Chrome Web Store listing

What to paste into the developer dashboard for Trench Overlay. Keep it in step with what the
extension does. The privacy policy (`apps/web/public/extension-privacy.html`) says the same.

## Store listing

- **Name:** Trench Overlay
- **Summary** (the manifest description, 132 characters at most): Your TrenchScanner alerts, with
  their flags, in a panel beside Axiom, Terminal and GMGN.
- **Category:** Tools
- **Language:** English
- **Description** (plain text; the store shows it as written):

  ```
  Your TrenchScanner alerts, right beside the chart.

  Trench Overlay keeps a live feed of your TrenchScanner alerts in Chrome's side panel, so you never have to switch tabs while you trade on Axiom, Terminal or GMGN.

  WHAT YOU SEE
  • Every token your filters match and every call from the models you follow, within seconds
  • Token image and name, which model or filter flagged it, and when
  • Market cap at alert and now, green when it's up and red when it's down
  • The holder flags you care about (bundled supply, snipers, linked wallets, dev holdings and more), graded against your own limits
  • Click any alert for its latest bubble map: linked clusters, KOL bundled, same-minute, CEX-funded, dev-tied and transferred supply, snipers and fresh wallets, each with its share

  TRADE BUDDY
  • Every coin your connected wallet buys, on any site, shows up with its token card, bubble map and your PnL
  • Pro accounts get a trade box on each coin, collapsed until you open it: it opens TrenchScanner's Trade panel filled in, and your wallet confirms there

  ONE CLICK TO ACT
  • Open any token on Axiom, Terminal, GMGN or TrenchScanner
  • Copy the contract address
  • Updates every 5 seconds while the panel is open

  BUILT TO STAY OUT OF YOUR TRADING
  The extension never runs on any website. It can't see your exchange pages, logins or wallet apps, and it can't trade or move funds. It only talks to TrenchScanner, using a key you can revoke anytime from Settings.

  GETTING STARTED
  Requires a paid TrenchScanner account. Install, open the panel, press Connect with TrenchScanner, and you're set. No keys to copy.
  ```

- **Icon:** `static/icons/icon-128.png`
- **Screenshots** (1280×800): `store/screenshot-1.png` (alerts), `store/screenshot-2.png` (settings)
- **Small promo tile** (440×280): `store/promo-small.png`
- **Marquee promo tile** (1400×560): `store/promo-marquee.png`
- The images show what a paid, non-admin account sees: the AI reviewer's verdicts are admin-only.
- **Official URL / homepage:** https://trenchscanner.app
- **Privacy policy:** https://trenchscanner.app/extension-privacy.html

## Privacy practices

- **Single purpose:** Shows the user's own TrenchScanner token alerts (filter matches and model
  calls) and the coins their own wallet trades, with holder stats, bubble maps, flags and PnL, in
  Chrome's side panel, and links to open each token on the trading site the user picks.
- **Permission justifications:**
  - `storage`: keeps the user's TrenchScanner extension key and display settings on this device.
  - `sidePanel`: the extension's only interface is a side panel.
  - No host permissions: the extension calls only the TrenchScanner API, which allows it by CORS,
    so it asks for no access to any site.
- **Remote code:** No. All code ships in the package.
- **Data usage**, the boxes to tick: **Authentication information** (the extension key) only.
  Certify all three: not sold to third parties; not used or transferred for purposes unrelated to
  the single purpose; not used for creditworthiness or lending.

## Distribution

- **Visibility:** Unlisted for the beta (user decision 2026-10-23), then Public.
- **Regions:** all.

## Account and release safety

- Use a dedicated Google account with a hardware security key as its only 2-step method, and add as
  few people as possible.
- After the first publish, opt in to **verified uploads** (Package tab) and keep the signing key
  offline. Then a stolen account alone can't ship an update.
- Upload only `npm run package` output from a commit on main. The version rule in README.md applies.
