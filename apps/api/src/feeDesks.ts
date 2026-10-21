/**
 * Creator-fee desks (user ask 2026-10-21): some Pump.fun coins send the creator fee to a
 * wallet, and that wallet is a service which routes it onward.
 *
 * OTC Desks (otcdesks.cash) publishes the coins it launches at GET /api/coins. Each coin can
 * name a reward symbol, or a basket of reward-coin mints (the response shape recorded from
 * that public roster on 2026-09-10). A line is returned only when one of those is present.
 * The roster does not publish a fee-split percent, and the copies of that percent disagree,
 * so none is stated here.
 *
 * Paid, which would name an XMoney user, is not in Pump.fun's public docs, the 2026-06-17
 * coins-v2 capture, @pump-fun/pump-sdk 4.2.0 (social platforms stop at GitHub), or TokenSage's
 * fee decoder. Nothing is invented for it.
 */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A reward ticker as the OTC roster prints it: NVDAx, OTC, $WIF. Not a sentence. */
const REWARD_SYMBOL = /^\$?[A-Za-z][A-Za-z0-9]{0,19}$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rewardSymbol(value: unknown): string | null {
  const symbol = text(value);
  return REWARD_SYMBOL.test(symbol) ? symbol : null;
}

/** Distinct reward-coin mints. One mint is not "several reward coins". */
function rewardBasket(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const mints: string[] = [];
  for (const item of value) {
    const mint = text(item);
    if (!BASE58.test(mint) || mints.includes(mint)) continue;
    mints.push(mint);
    if (mints.length === 32) break;
  }
  return mints.length > 1 ? mints : [];
}

/**
 * One sentence for the tooltip and the token-details line, or null when this coin's
 * reward routing is not in the roster record.
 */
export function feeDeskLineFromOtcCoin(coin: unknown): string | null {
  if (!coin || typeof coin !== "object" || Array.isArray(coin)) return null;
  const row = coin as { rewardSymbol?: unknown; rewardBasket?: unknown };
  const symbol = rewardSymbol(row.rewardSymbol);
  const basket = rewardBasket(row.rewardBasket);
  if (basket.length > 0) {
    const named = symbol ? ` (${symbol} is named)` : "";
    return `OTC Desks pays holder rewards in ${basket.length} reward coins${named}.`;
  }
  if (symbol) return `OTC Desks pays holder rewards in ${symbol}.`;
  return null;
}

/** mint -> sentence, for a GET /api/coins body. Coins with no named reward are left out. */
export function feeDeskLinesFromOtcRoster(body: unknown): Map<string, string> {
  const record =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const coins = Array.isArray(body)
    ? body
    : Array.isArray(record?.coins)
      ? record.coins
      : Array.isArray(record?.data)
        ? record.data
        : Array.isArray(record?.tokens)
          ? record.tokens
          : [];
  const lines = new Map<string, string>();
  for (const coin of coins) {
    if (!coin || typeof coin !== "object" || Array.isArray(coin)) continue;
    const mint = text((coin as { mint?: unknown }).mint);
    if (!BASE58.test(mint) || lines.has(mint)) continue;
    const line = feeDeskLineFromOtcCoin(coin);
    if (line) lines.set(mint, line);
  }
  return lines;
}
