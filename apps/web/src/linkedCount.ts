import type { Snapshot } from "./api";

/*
 * The Linked count, apart from bubbleMap.ts so alert cards can show it without loading the bubble
 * map's layout code on the first screen.
 */

/** Holders the linked reading covered on scans that didn't keep the count: RugCheck's top 20. */
export const LINKED_HOLDERS_READ = 20;

/**
 * Linked as a count (user ask 2026-10-13): how many top holders are in a linked cluster, of how
 * many were read, shown "N/25". Scans before the count was kept count the clusters' wallets. Null
 * when the reading isn't in.
 */
export function linkedCount(
  s: Pick<
    Snapshot,
    "linkedWalletPct" | "linkedWalletCount" | "linkedWalletsChecked" | "linkedClusters" | "linkedHolders"
  >,
): { linked: number; of: number } | null {
  if (s.linkedWalletPct == null) return null;
  if (s.linkedWalletCount != null) {
    return { linked: s.linkedWalletCount, of: s.linkedWalletsChecked ?? LINKED_HOLDERS_READ };
  }
  const wallets = new Set((s.linkedClusters ?? []).flatMap((c) => (c?.wallets ?? []).map((w) => w.wallet)));
  return { linked: wallets.size, of: s.linkedHolders?.length || LINKED_HOLDERS_READ };
}

/** "4/20", or null without a reading. */
export function linkedCountText(c: { linked: number; of: number } | null): string | null {
  return c ? `${c.linked}/${c.of}` : null;
}
