import { holderTags } from "../shared/holders";
import { isMintAddress, mintsIn } from "../shared/mint";
import type { OverlayBubbleMap } from "../shared/types";

/**
 * The panel's lookup (user ask 2026-10-25): any coin by its address, with its card, bubble map and
 * top holders tagged as the holder markers tag them on a coin's page. Built with DOM calls only.
 */

/** How many of the map's top holders the list shows. */
export const HOLDERS_SHOWN = 20;

/** The coin a pasted text names: an address, or a link with one (a site's coin page). */
export function mintFrom(text: string): string | null {
  const t = text.trim();
  if (isMintAddress(t)) return t;
  return mintsIn(t)[0] ?? null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The map's top holders, largest first, each with its share and the map's tags. */
export function holderList(
  map: OverlayBubbleMap,
  colors: { risk: string; mid: string; link: string },
): HTMLElement {
  const box = el("div", "holders");
  const holders = [...map.holders].sort((a, b) => b.pct - a.pct).slice(0, HOLDERS_SHOWN);
  for (const holder of holders) {
    const row = el("div", "holder");
    const wallet = el("a", "", `${holder.wallet.slice(0, 4)}…${holder.wallet.slice(-4)}`);
    if (isMintAddress(holder.wallet)) wallet.href = `https://solscan.io/account/${holder.wallet}`;
    wallet.target = "_blank";
    wallet.rel = "noopener noreferrer";
    row.append(wallet);
    for (const tag of holderTags(holder, map, colors)) {
      const b = el("b", "htag", tag.text);
      b.title = tag.why;
      b.style.setProperty("--t", tag.color);
      row.append(b);
    }
    row.append(el("span", "pct", `${holder.pct.toFixed(2)}%`));
    box.append(row);
  }
  return box;
}
