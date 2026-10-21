/**
 * Creator-fee desks (user ask 2026-10-21): some Pump.fun coins send the creator fee to a
 * wallet, and that wallet is a service which routes it onward.
 *
 * OTC Desks (otcdesks.cash) publishes the coins it launches at GET /api/coins. Each coin can
 * name a reward symbol, or a basket of reward-coin mints (the response shape recorded from
 * that public roster on 2026-09-10). A basket entry may also carry `symbol` or `name`. A
 * mint with neither is named from another coin on the same roster when that coin has a
 * ticker or a short name, and otherwise the mint is shortened. Every coin in a basket is
 * named. One ticker is not copied onto every mint, and it is not added as an extra coin.
 * A line is returned only when a reward is actually named. Fee-split fields are not read.
 * A reward symbol that is not a ticker, or a basket that is not a list, returns nothing.
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

/** A roster coin's name, when it is a name and not a sentence. */
function rewardName(value: unknown): string | null {
  const name = text(value);
  if (!name || name.length > 40 || !/\p{L}/u.test(name) || /[.!?\n]/.test(name)) return null;
  return name;
}

function mintOf(value: unknown): string | null {
  const mint = text(value);
  return BASE58.test(mint) ? mint : null;
}

/** The same short mint the rest of the UI uses when a token has no ticker (`abcd…wxyz`). */
export function shortRewardMint(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/** One reward coin. `label` is the ticker, the roster name, or the mint shortened. */
export interface OtcRewardCoin {
  label: string;
  mint: string | null;
}

/** The tooltip sentence, plus each reward coin so a surface that can render tokens can. */
export interface OtcDeskFee {
  line: string;
  rewards: OtcRewardCoin[];
}

interface BasketEntry {
  mint: string | null;
  label: string | null;
}

/**
 * Distinct reward coins. A string entry is a mint. An object may also carry `symbol`,
 * `rewardSymbol`, or `name`. Other keys (a fee split, for one) are not read. An entry that
 * is neither a mint nor a name is skipped. More than 32 distinct coins is not trusted.
 */
function rewardCoins(value: unknown): BasketEntry[] | "bad" {
  if (value == null) return [];
  if (!Array.isArray(value)) return "bad";
  const coins: BasketEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item == null || item === "") continue;
    let mint: string | null;
    let label: string | null = null;
    if (typeof item === "string") {
      mint = mintOf(item);
      if (!mint) return "bad";
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const row = item as { mint?: unknown; symbol?: unknown; name?: unknown; rewardSymbol?: unknown };
      if (row.mint != null && !mintOf(row.mint)) return "bad";
      if (typeof row.symbol === "string" && row.symbol.trim() && !rewardSymbol(row.symbol)) return "bad";
      if (typeof row.rewardSymbol === "string" && row.rewardSymbol.trim() && !rewardSymbol(row.rewardSymbol))
        return "bad";
      mint = mintOf(row.mint);
      label = rewardSymbol(row.symbol) ?? rewardSymbol(row.rewardSymbol) ?? rewardName(row.name);
      if (!mint && !label) return "bad";
    } else {
      return "bad";
    }
    const key = mint ?? `label:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    coins.push({ mint, label });
    if (coins.length > 32) return "bad";
  }
  return coins;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function lineFrom(rewards: OtcRewardCoin[]): string {
  return `OTC Desks pays holder rewards in ${joinNames(rewards.map((reward) => reward.label))}.`;
}

/**
 * The desk sentence and each reward coin, or null when this coin's reward routing is not in
 * the roster record. `known` maps a reward mint to a ticker or short name from another coin
 * on the same roster. A basket of several coins names every coin. A mint with no name is
 * shortened rather than dropped.
 */
export function feeDeskFromOtcCoin(coin: unknown, known?: ReadonlyMap<string, string>): OtcDeskFee | null {
  if (!coin || typeof coin !== "object" || Array.isArray(coin)) return null;
  const row = coin as { rewardSymbol?: unknown; rewardMint?: unknown; rewardBasket?: unknown };
  if (row.rewardSymbol != null && typeof row.rewardSymbol !== "string") return null;
  if (typeof row.rewardSymbol === "string" && row.rewardSymbol.trim() && !rewardSymbol(row.rewardSymbol))
    return null;
  const symbol = rewardSymbol(row.rewardSymbol);
  // `pending:<SYMBOL>` is the roster's unpublished mint. It is not a token address.
  const rewardMint = mintOf(row.rewardMint);
  const basket = rewardCoins(row.rewardBasket);
  if (basket === "bad") return null;
  const only = basket.length === 1 ? basket[0] : undefined;
  let rewards: OtcRewardCoin[];
  if (basket.length === 0) {
    if (symbol) rewards = [{ label: symbol, mint: rewardMint }];
    else if (rewardMint) rewards = [{ label: shortRewardMint(rewardMint), mint: rewardMint }];
    else return null;
  } else if (only && !only.label) {
    const fromRoster = only.mint ? (known?.get(only.mint) ?? null) : null;
    const label = symbol ?? fromRoster ?? (only.mint ? shortRewardMint(only.mint) : null);
    if (!label) return null;
    rewards = [{ label, mint: only.mint }];
  } else {
    rewards = [];
    for (const entry of basket) {
      const fromRoster = entry.mint ? (known?.get(entry.mint) ?? null) : null;
      const label = entry.label ?? fromRoster ?? (entry.mint ? shortRewardMint(entry.mint) : null);
      if (!label) return null;
      rewards.push({ label, mint: entry.mint });
    }
  }
  if (rewards.length === 0) return null;
  return { line: lineFrom(rewards), rewards };
}

/** The tooltip sentence, or null when this coin's reward routing is not in the roster record. */
export function feeDeskLineFromOtcCoin(coin: unknown, known?: ReadonlyMap<string, string>): string | null {
  return feeDeskFromOtcCoin(coin, known)?.line ?? null;
}

/** Coins in a GET /api/coins body: a list, or `coins` / `data` / `tokens`. */
export function otcRosterCoins(body: unknown): unknown[] | null {
  return rosterCoins(body);
}

function rosterCoins(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.coins)) return record.coins;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.tokens)) return record.tokens;
  return null;
}

/** mint -> ticker or short name, from coins on this roster. The first coin for a mint wins. */
function rewardNamesByMint(coins: readonly unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const coin of coins) {
    if (!coin || typeof coin !== "object" || Array.isArray(coin)) continue;
    const row = coin as { mint?: unknown; symbol?: unknown; name?: unknown };
    const mint = mintOf(row.mint);
    if (!mint || names.has(mint)) continue;
    const label = rewardSymbol(row.symbol) ?? rewardName(row.name);
    if (label) names.set(mint, label);
  }
  return names;
}

/**
 * mint -> desk fee, for a GET /api/coins body. Coins with no named reward are left out.
 * A mint's first row often has no reward fields (the featured set). That row does not
 * block a later row that names the reward coins.
 */
export function feeDesksFromOtcRoster(body: unknown): Map<string, OtcDeskFee> {
  const coins = rosterCoins(body);
  if (!coins) return new Map();
  const known = rewardNamesByMint(coins);
  const fees = new Map<string, OtcDeskFee>();
  for (const coin of coins) {
    if (!coin || typeof coin !== "object" || Array.isArray(coin)) continue;
    const mint = mintOf((coin as { mint?: unknown }).mint);
    if (!mint || fees.has(mint)) continue;
    const fee = feeDeskFromOtcCoin(coin, known);
    if (fee) fees.set(mint, fee);
  }
  return fees;
}
