import { ago } from "./format";

/**
 * The DexScreener token-info label (user ask 2026-10-21). Feed cards, Scope rows, the Stream,
 * and the token title share this pill, and every variant shows "DP". The title still says
 * whether it was a payment or a later update, and when. A profile block with no payment time
 * has no time in the title. Nothing is shown for a token with neither, and no time is invented.
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
  /** Payment time in ms. Null when the pair only has a profile block, which carries no time. */
  paidAtMs: number | null;
}

/** The visible pill. Paid, updated, and info-only all use this; the title carries the event. */
const DEX_INFO_PILL = "DP";

export function dexInfoLabel(token: DexInfoSource, now = Date.now()): DexInfoLabelText | null {
  const paidAtMs = token.dexInfoPaidAt ? Date.parse(token.dexInfoPaidAt) : NaN;
  const hasTime = Number.isFinite(paidAtMs);
  if (!token.dexInfo && !hasTime) return null;
  if (hasTime && token.dexInfoUpdated) {
    const when = ago(new Date(paidAtMs), now);
    return { text: DEX_INFO_PILL, title: `DexScreener token info updated ${when}`, paidAtMs };
  }
  if (hasTime) {
    const when = ago(new Date(paidAtMs), now);
    return { text: DEX_INFO_PILL, title: `DexScreener token info paid ${when}`, paidAtMs };
  }
  return {
    text: DEX_INFO_PILL,
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

/** The short label next to a ticker: feed cards, Scope, the Stream, and the token title share this pill. */
export function DexInfoLabel({ token, now }: { token: DexInfoSource; now?: number }) {
  const label = dexInfoLabel(token, now);
  if (!label) return null;
  return (
    <span className="pill dex-info" title={label.title}>
      {label.text}
    </span>
  );
}
