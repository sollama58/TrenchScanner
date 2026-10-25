import type { OverlayBubbleHolder, OverlayBubbleMap } from "./types";

/**
 * What TrenchScanner's bubble map says of one top holder, as short tags: the holder markers on a
 * coin's page (content/holderMarks.ts) and the panel's lookup (panel/coin.ts) show the same.
 */

/** Cluster colours, by cluster index: one per funder on the map. */
export const CLUSTER_COLORS = [
  "#ff7a35",
  "#3fd7c9",
  "#b48cff",
  "#ffd166",
  "#ff5fa2",
  "#5cc8ff",
  "#8be36b",
  "#ff9b6a",
];

export interface HolderTag {
  text: string;
  color: string;
  why: string;
}

/** What the map says of one holder, as chips; none for a plain one. */
export function holderTags(
  holder: OverlayBubbleHolder,
  map: OverlayBubbleMap,
  colors: { risk: string; mid: string; link: string },
): HolderTag[] {
  const tags: HolderTag[] = [];
  if (holder.cluster !== null) {
    const c = map.clusters[holder.cluster];
    tags.push({
      text: `C${holder.cluster + 1}`,
      color: CLUSTER_COLORS[holder.cluster % CLUSTER_COLORS.length]!,
      why: c
        ? `Cluster ${holder.cluster + 1}: ${c.count} wallets one funder paid for, ${c.pct.toFixed(1)}% of supply${c.creatorLinked ? ", linked to the creator" : ""}`
        : `Cluster ${holder.cluster + 1}`,
    });
  }
  if (holder.sameTime !== null)
    tags.push({ text: "SAME", color: colors.mid, why: "Funded in the same minute as other top holders" });
  if (holder.trait === "blockZero")
    tags.push({ text: "B0", color: colors.risk, why: "Bought in the launch block" });
  if (holder.trait === "sniper") tags.push({ text: "SNPR", color: colors.risk, why: "Sniper" });
  if (holder.trait === "fresh") tags.push({ text: "FRESH", color: colors.mid, why: "Fresh wallet" });
  if (holder.trait === "empty")
    tags.push({ text: "EMPTY", color: colors.mid, why: "Wallet holding nothing else" });
  if (holder.cex) tags.push({ text: "CEX", color: colors.link, why: "Funded from an exchange" });
  if (holder.creatorTied) tags.push({ text: "DEV", color: colors.risk, why: "Tied to the dev" });
  return tags;
}
