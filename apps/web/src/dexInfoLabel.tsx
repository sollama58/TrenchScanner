import { ago } from "./format";

/**
 * The DexScreener token-info label (user ask 2026-10-21). Feed cards, Scope rows, and the token
 * title share this pill. A paid order shows "DP"; the title still says when it was paid. "DS
 * updated" when a later update has a time; "DS info" when the pair only has a profile block,
 * which carries no time. Nothing is shown for a token with neither, and no time is invented.
 */
export interface DexInfoSource {
  dexInfo?: boolean | null;
  /** ISO time from DexScreener's paymentTimestamp. Null or absent when we have none. */
  dexInfoPaidAt?: string | null;
  dexInfoUpdated?: boolean | null;
}

export interface DexInfoLabelText {
  text: string;
  title: string;
  /** Payment time in ms, or null when the label is only "this token has DexScreener info". */
  paidAtMs: number | null;
}

export function dexInfoLabel(token: DexInfoSource, now = Date.now()): DexInfoLabelText | null {
  const paidAtMs = token.dexInfoPaidAt ? Date.parse(token.dexInfoPaidAt) : NaN;
  const hasTime = Number.isFinite(paidAtMs);
  if (!token.dexInfo && !hasTime) return null;
  if (hasTime && token.dexInfoUpdated) {
    const when = ago(new Date(paidAtMs), now);
    return { text: `DS updated ${when}`, title: `DexScreener token info updated ${when}`, paidAtMs };
  }
  if (hasTime) {
    const when = ago(new Date(paidAtMs), now);
    return { text: "DP", title: `DexScreener token info paid ${when}`, paidAtMs };
  }
  return {
    text: "DS info",
    title: "DexScreener token info. The pair lists a profile, and there is no payment time.",
    paidAtMs: null,
  };
}

/** The chart bubble. Only when there is a payment time — the profile block alone has nowhere to sit. */
export function dexInfoChartMark(
  token: DexInfoSource,
  now = Date.now(),
): { t: number; text: string; updated: boolean } | null {
  const label = dexInfoLabel(token, now);
  if (!label || label.paidAtMs === null) return null;
  return { t: label.paidAtMs, text: label.title, updated: !!token.dexInfoUpdated };
}

/** The short label next to a ticker: feed cards, Scope rows, and the token view share this pill. */
export function DexInfoLabel({ token, now }: { token: DexInfoSource; now?: number }) {
  const label = dexInfoLabel(token, now);
  if (!label) return null;
  return (
    <span className="pill dex-info" title={label.title}>
      {label.text}
    </span>
  );
}
