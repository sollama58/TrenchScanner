/** Mirrors apps/api/src/routes/tokens.ts HolderEntry: one holder's trades in the coin, from the trade tape. */
export interface HolderEntry {
  firstBuyAt: number | null;
  afterLaunchS: number | null;
  firstBuyerRank: number | null;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  soldShare: number | null;
  /**
   * Whole tokens bought and sold on the tape. Absent from API builds from before they were sent.
   * 0 means the tape read none, not that the amounts were never calculated.
   */
  tokensBought?: number;
  tokensSold?: number;
}

const sol = (v: number) => `${v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)} SOL`;

/** "4s", "3m", "2h 5m", "3d": how long after the launch. */
export function afterText(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) {
    const m = Math.round((s % 3_600) / 60);
    return `${Math.floor(s / 3_600)}h${m > 0 && s < 36_000 ? ` ${m}m` : ""}`;
  }
  return `${Math.round(s / 86_400)}d`;
}

/**
 * The top-holder row's line on how it got in (user ask 2026-10-17): "Bought 4s after launch
 * (#3 buyer) · 2.1 SOL · sold 40% for 1.8 SOL", or "Got it by transfer, never bought".
 */
export function entryText(e: HolderEntry): string {
  return entryParts(e).join(" · ");
}

/** entryText's pieces, each kept on one line in the row. */
export function entryParts(e: HolderEntry): string[] {
  if (e.buys === 0)
    return e.sells > 0
      ? ["Got it by transfer", `sold for ${sol(e.solOut)}`]
      : ["Got it by transfer, never bought"];
  const when = e.afterLaunchS !== null ? `Bought ${afterText(e.afterLaunchS)} after launch` : "Bought";
  const rank = e.firstBuyerRank !== null ? ` (#${e.firstBuyerRank} buyer)` : "";
  const parts = [`${when}${rank}`, sol(e.solIn)];
  const sold = e.soldShare ?? 0;
  if (e.sells === 0 || sold <= 0) parts.push("holding all");
  else if (sold >= 0.995) parts.push(`sold all for ${sol(e.solOut)}`);
  else parts.push(`sold ${Math.max(1, Math.round(sold * 100))}% for ${sol(e.solOut)}`);
  return parts;
}

/** The line's tooltip: the counts behind it. */
export function entryTitle(e: HolderEntry): string {
  const n = (v: number, w: string) => `${v} ${w}${v === 1 ? "" : "s"}`;
  return `${n(e.buys, "buy")} for ${sol(e.solIn)}, ${n(e.sells, "sell")} for ${sol(e.solOut)}, as the trade tape read them`;
}
