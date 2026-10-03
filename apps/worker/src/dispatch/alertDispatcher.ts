import type { FilterTrackRecord, Token, TokenSnapshot } from "@trenchscanner/core";

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

/** Below this many graded alerts a percentage is noise, so the card shows counts only. */
const TRACK_RECORD_MIN_FOR_PCT = 10;

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(0)}%`;
}

/**
 * The realtime Telegram card. Besides the headline numbers it carries what a manual trader checks
 * first - the last 5 minutes and hour, who holds the hour's flow, venue and age, the sniper
 * checks - and, when known, which filter caught the token and how that filter's alerts have done
 * on the curated feed's verdict (2x within 1h of a realistic fill, a 50% drop first is a loss).
 */
export function formatRealtimeAlert(
  token: Token,
  snapshot: TokenSnapshot,
  score: number,
  extras: { filterName?: string; trackRecord?: FilterTrackRecord } = {},
): string {
  const name = token.name ?? token.symbol ?? token.mintAddress.slice(0, 8);
  const dexUrl = `https://dexscreener.com/solana/${token.pairAddress ?? token.mintAddress}`;

  const moves = [
    snapshot.priceChange5mPct !== null ? `5m ${fmtPct(snapshot.priceChange5mPct)}` : undefined,
    snapshot.priceChange1hPct !== null ? `1h ${fmtPct(snapshot.priceChange1hPct)}` : undefined,
  ].filter((m): m is string => m !== undefined);
  const txns1h = (snapshot.buys1h ?? 0) + (snapshot.sells1h ?? 0);
  if (txns1h > 0) moves.push(`buys ${Math.round(((snapshot.buys1h ?? 0) / txns1h) * 100)}% of 1h txns`);

  const venue =
    snapshot.graduated === true ? "Graduated" : snapshot.graduated === false ? "Bonding curve" : undefined;
  const age = snapshot.ageMinutes !== null ? fmtAge(snapshot.ageMinutes) : undefined;
  const liquidity =
    snapshot.liquidityUsd !== null && snapshot.graduated === true
      ? `liq ${fmtUsd(snapshot.liquidityUsd)}`
      : undefined;
  const market = [venue, age && `${age} old`, liquidity].filter(Boolean).join(" · ");

  const holders = [
    snapshot.holderCount !== null ? `${snapshot.holderCount} holders` : undefined,
    snapshot.top10HolderPct !== null ? `top 10 hold ${snapshot.top10HolderPct.toFixed(0)}%` : undefined,
    snapshot.freshTop10WalletPct !== null
      ? `fresh wallets ${snapshot.freshTop10WalletPct.toFixed(0)}%`
      : undefined,
    snapshot.emptyTop10WalletPct !== null
      ? `empty wallets ${snapshot.emptyTop10WalletPct.toFixed(0)}%`
      : undefined,
  ].filter(Boolean);

  const lines = [
    `🎯 <b>${escapeHtml(name)}${token.symbol ? ` ($${escapeHtml(token.symbol)})` : ""}</b>`,
    extras.filterName ? `Filter: ${escapeHtml(extras.filterName)}` : undefined,
    `Score: <b>${score.toFixed(0)}/100</b>`,
    `Market cap: ${fmtUsd(snapshot.marketCapUsd)}`,
    moves.length > 0 ? moves.join(" · ") : undefined,
    market || undefined,
    snapshot.volume24hUsd !== null ? `24h volume: ${fmtUsd(snapshot.volume24hUsd)}` : undefined,
    holders.length > 0 ? holders.join(" · ") : undefined,
    extras.trackRecord ? formatTrackRecord(extras.trackRecord) : undefined,
    "",
    `<a href="${dexUrl}">View on DexScreener</a>`,
    `<code>${token.mintAddress}</code>`,
  ].filter((l): l is string => l !== undefined);
  return lines.join("\n");
}

/** One line: this filter's last-30-day record on the curated verdict, or that none is graded yet. */
export function formatTrackRecord(record: FilterTrackRecord): string {
  if (record.graded === 0) return "This filter: no graded alerts yet";
  if (record.graded < TRACK_RECORD_MIN_FOR_PCT) {
    return `This filter (30d): ${record.won2x} of ${record.graded} graded alerts hit 2x within 1h`;
  }
  const pct = (n: number) => Math.round((n / record.graded) * 100);
  return `This filter (30d): ${pct(record.won2x)}% hit 2x, ${pct(record.won4x)}% hit 4x within 1h (${record.graded} graded)`;
}

function fmtAge(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))}m`;
  if (minutes < 2_880) return `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)}h`;
  return `${Math.round(minutes / 1_440)}d`;
}

/**
 * `total` is how many matches the digest is actually reporting on, which is not `entries.length`
 * once the 25-row cap bites: a user with a busy filter was told "25 matches" on a day with three
 * hundred, and the header is the only number most readers take from the message.
 */
export function formatDigest(
  entries: { token: Token; snapshot: TokenSnapshot; score: number }[],
  total = entries.length,
): string {
  if (entries.length === 0) {
    return "No new matches since your last digest. TrenchScanner is still watching.";
  }
  const header =
    total > entries.length
      ? `📋 <b>Daily digest — top ${entries.length} of ${total} matches</b>\n`
      : `📋 <b>Daily digest — ${total} match${total === 1 ? "" : "es"}</b>\n`;
  const rows = entries
    .sort((a, b) => b.score - a.score)
    .map((e) => {
      const name = e.token.name ?? e.token.symbol ?? e.token.mintAddress.slice(0, 8);
      return `• <b>${escapeHtml(name)}</b> — score ${e.score.toFixed(0)}, mcap ${fmtUsd(e.snapshot.marketCapUsd)}`;
    });
  return [header, ...rows].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
