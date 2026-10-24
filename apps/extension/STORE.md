# Chrome Web Store listing

What to paste into the developer dashboard for Trench Overlay. Keep it in step with what the
extension does. The privacy policy (`apps/web/public/extension-privacy.html`) says the same.

## Store listing

- **Name:** Trench Overlay
- **Summary** (the manifest description, 132 characters at most): Your TrenchScanner alerts, with
  their flags, in a panel beside Axiom, Terminal and GMGN.
- **Category:** Tools
- **Language:** English
- **Description:**

  > Trench Overlay keeps your TrenchScanner alerts open in Chrome's side panel while you trade.
  >
  > Every token your filters matched and every call from the models you follow shows up within
  > seconds. Each card has the token's image and name, the model and filter that flagged it, the
  > market cap when it was alerted and now (green up, red down), and the holder flags you choose:
  > bundled supply, snipers, linked wallets, dev holding and more, graded against your own limits.
  > One click opens the token on Axiom, Terminal, GMGN or TrenchScanner. Another copies the
  > contract address.
  >
  > Built to stay out of your trading. The extension never runs on any website, so it can't see
  > your exchange pages, logins or wallets. It only talks to TrenchScanner.
  >
  > Needs a paid TrenchScanner account. Connect it in one click from TrenchScanner Settings.

- **Icon:** `static/icons/icon-128.png`
- **Screenshots** (1280×800): `store/screenshot-1.png` (alerts), `store/screenshot-2.png` (settings)
- **Small promo tile** (440×280): `store/promo-small.png`
- **Official URL / homepage:** https://trenchscanner.app
- **Privacy policy:** https://trenchscanner.app/extension-privacy.html

## Privacy practices

- **Single purpose:** Shows the user's own TrenchScanner token alerts and stats in Chrome's side
  panel.
- **Permission justifications:**
  - `storage`: keeps the user's TrenchScanner extension key and display settings on this device.
  - `sidePanel`: the extension's only interface is a side panel.
  - Host `https://api.trenchscanner.app/*`: the TrenchScanner API, the one service it reads alerts
    from and saves settings to.
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
