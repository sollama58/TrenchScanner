import { mountTokenMap, type SiteAnswer, type SiteCall } from "@site/tokenMapEmbed";

/**
 * The site's own bubble map in the extension (user ask 2026-10-25: the extension's maps look and
 * act as the site's). The site's map code is bundled in (apps/web/src/embed/tokenMapEmbed.tsx)
 * and every read it makes goes to the service worker, which makes it through the key
 * (POST /ext/v1/site): the API replays the site map's own reads as the key's owner and refuses any
 * other route. It follows the coin live as the token view does (its holder wait, top 50 and live
 * trades), so nothing here polls.
 */

/** A map read, answered by the service worker. */
export function siteRequest(call: SiteCall): Promise<SiteAnswer> {
  return (chrome.runtime.sendMessage({ type: "site", ...call }) as Promise<SiteAnswer | null>).then(
    (a) => a ?? { status: 503, body: JSON.stringify({ error: "offline" }) },
    () => ({ status: 503, body: JSON.stringify({ error: "offline" }) }),
  );
}

let sheet: Promise<CSSStyleSheet> | null = null;
/** The host in the panel: the card's own background shows through, as the old map's did. */
const HOST_CSS = ":host { display: block; background: transparent !important; margin-top: 8px; }";

/** The site's stylesheet for a shadow root (build.mjs map-shadow.css), read once per page. */
function siteSheet(): Promise<CSSStyleSheet> {
  sheet ??= fetch(chrome.runtime.getURL("map-shadow.css"))
    .then((r) => r.text())
    .then((css) => new CSSStyleSheet().replace(css));
  return sheet;
}

/**
 * The map for `mint` in a shadow root of its own, so the site's styles reach only the map. The
 * node can be moved between redraws without the map losing its place; `stop` unmounts it.
 */
export function siteMapNode(mint: string): { node: HTMLElement; stop: () => void } {
  const node = document.createElement("div");
  node.className = "site-map";
  const root = node.attachShadow({ mode: "closed" });
  const box = document.createElement("div");
  box.className = "site-map-root";
  root.append(box);
  void siteSheet().then(
    (s) => {
      const host = new CSSStyleSheet();
      host.replaceSync(HOST_CSS);
      root.adoptedStyleSheets = [s, host];
    },
    () => undefined,
  );
  const unmount = mountTokenMap(box, mint, siteRequest);
  // The site's theme rides on the page's root (its appearance.ts); its stylesheet reads it off the host here.
  const theme = () => {
    const t = document.documentElement.dataset.theme;
    if (t) node.dataset.theme = t;
    else delete node.dataset.theme;
  };
  theme();
  const watch = new MutationObserver(theme);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return {
    node,
    stop: () => {
      watch.disconnect();
      unmount();
    },
  };
}
