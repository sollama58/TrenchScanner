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
 * A pump coin is matched when its mint is on the roster, or when a creator-fee wallet equals
 * that coin (its mint, or a wallet address listed once on the coin).
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
 * `ticker`, `rewardSymbol`, `name`, or `address` (the mint when the roster renamed `mint`).
 * Other keys (a fee split, for one) are not read. An entry that is neither a mint nor a
 * name is skipped. More than 32 distinct coins is not trusted.
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
      const row = item as {
        mint?: unknown;
        address?: unknown;
        symbol?: unknown;
        ticker?: unknown;
        name?: unknown;
        rewardSymbol?: unknown;
      };
      const mintRaw = row.mint ?? row.address;
      if ((row.mint != null || row.address != null) && !mintOf(mintRaw)) return "bad";
      if (typeof row.symbol === "string" && row.symbol.trim() && !rewardSymbol(row.symbol)) return "bad";
      if (typeof row.ticker === "string" && row.ticker.trim() && !rewardSymbol(row.ticker)) return "bad";
      if (typeof row.rewardSymbol === "string" && row.rewardSymbol.trim() && !rewardSymbol(row.rewardSymbol))
        return "bad";
      mint = mintOf(mintRaw);
      label =
        rewardSymbol(row.symbol) ??
        rewardSymbol(row.ticker) ??
        rewardSymbol(row.rewardSymbol) ??
        rewardName(row.name);
      if (!mint && !label) return "bad";
    } else {
      return "bad";
    }
    const key = mint?.toLowerCase() ?? `label:${label}`;
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

/** Ticker for a reward mint. The roster's own casing wins; a case-only difference still matches. */
function nameForMint(known: ReadonlyMap<string, string> | undefined, mint: string): string | null {
  if (!known) return null;
  const exact = known.get(mint);
  if (exact) return exact;
  const want = mint.toLowerCase();
  let found: string | null = null;
  for (const [key, label] of known) {
    if (key.toLowerCase() !== want) continue;
    if (found && found !== label) return null;
    found = label;
  }
  return found;
}

/**
 * The desk sentence and each reward coin, or null when this coin's reward routing is not in
 * the roster record. `known` maps a reward mint to a ticker or short name from another coin
 * on the same roster. A basket of several coins names every coin. A mint with no name is
 * shortened rather than dropped.
 */
export function feeDeskFromOtcCoin(coin: unknown, known?: ReadonlyMap<string, string>): OtcDeskFee | null {
  if (!coin || typeof coin !== "object" || Array.isArray(coin)) return null;
  const row = coin as {
    rewardSymbol?: unknown;
    rewardMint?: unknown;
    rewardBasket?: unknown;
    rewards?: unknown;
    reward_basket?: unknown;
  };
  if (row.rewardSymbol != null && typeof row.rewardSymbol !== "string") return null;
  if (typeof row.rewardSymbol === "string" && row.rewardSymbol.trim() && !rewardSymbol(row.rewardSymbol))
    return null;
  const symbol = rewardSymbol(row.rewardSymbol);
  // `pending:<SYMBOL>` is the roster's unpublished mint. It is not a token address.
  const rewardMint = mintOf(row.rewardMint);
  // `rewards` / `reward_basket` are the same list when `rewardBasket` was renamed.
  const basket = rewardCoins(row.rewardBasket ?? row.rewards ?? row.reward_basket);
  if (basket === "bad") return null;
  const only = basket.length === 1 ? basket[0] : undefined;
  let rewards: OtcRewardCoin[];
  if (basket.length === 0) {
    if (symbol) rewards = [{ label: symbol, mint: rewardMint }];
    else if (rewardMint) rewards = [{ label: shortRewardMint(rewardMint), mint: rewardMint }];
    else return null;
  } else if (only && !only.label) {
    const fromRoster = only.mint ? nameForMint(known, only.mint) : null;
    const label = symbol ?? fromRoster ?? (only.mint ? shortRewardMint(only.mint) : null);
    if (!label) return null;
    rewards = [{ label, mint: only.mint }];
  } else {
    rewards = [];
    for (const entry of basket) {
      const fromRoster = entry.mint ? nameForMint(known, entry.mint) : null;
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

/** A wallet-shaped field on a roster coin. Reward and pair mints are not fee destinations. */
const WALLET_FIELD = /wallet|authority|receiver|^owner$|^creator$|^address$|^admin$/i;

function pushMint(out: string[], value: unknown): void {
  const mint = mintOf(value);
  if (mint && !out.includes(mint)) out.push(mint);
}

/**
 * Wallet addresses on one roster coin, other than its mint. A fee split and the reward
 * basket are not wallets. Nested `{ address | wallet | pubkey | mint }` is read once.
 */
function walletAddressesOn(coin: object): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(coin as Record<string, unknown>)) {
    if (!WALLET_FIELD.test(key) || /reward|pair|basket/i.test(key)) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const row = value as Record<string, unknown>;
      for (const nested of ["address", "wallet", "pubkey", "mint"]) pushMint(out, row[nested]);
    } else {
      pushMint(out, value);
    }
  }
  return out;
}

/**
 * Creator-fee wallets TokenSage named, creator's own share excluded. `marketCreator` is
 * the sharing-config admin on a fee-shared coin (rules 0.19.0). Order is the order tried.
 */
export function creatorFeeWalletAddresses(fee: unknown, marketCreator?: unknown): string[] {
  const out: string[] = [];
  if (fee && typeof fee === "object" && !Array.isArray(fee)) {
    const row = fee as { admin?: unknown; recipients?: unknown };
    if (Array.isArray(row.recipients)) {
      for (const recipient of row.recipients) {
        if (!recipient || typeof recipient !== "object" || Array.isArray(recipient)) continue;
        const one = recipient as { address?: unknown; is_creator?: unknown; kind?: unknown };
        if (one.is_creator === true || one.kind === "creator") continue;
        pushMint(out, one.address);
      }
    }
    pushMint(out, row.admin);
  }
  pushMint(out, marketCreator);
  return out;
}

/**
 * The desk fee stored under `address`. Exact text wins. A case-only difference still
 * matches when exactly one roster key folds to it; two different coins do not.
 */
export function lookupOtcDeskFee(fees: ReadonlyMap<string, OtcDeskFee>, address: string): OtcDeskFee | null {
  const key = address.trim();
  if (!mintOf(key)) return null;
  const exact = fees.get(key);
  if (exact) return exact;
  const want = key.toLowerCase();
  let found: OtcDeskFee | null = null;
  for (const [candidate, fee] of fees) {
    if (candidate.toLowerCase() !== want) continue;
    if (found && found !== fee) return null;
    found = fee;
  }
  return found;
}

/**
 * Reward routing for a pump coin. Its own roster row wins. Otherwise the first
 * creator-fee wallet that is an OTC desk coin (mint or a wallet listed on one coin).
 */
export function resolveOtcDeskFee(
  mint: string,
  wallets: readonly string[] | null | undefined,
  fees: ReadonlyMap<string, OtcDeskFee>,
): OtcDeskFee | null {
  const own = lookupOtcDeskFee(fees, mint);
  if (own) return own;
  const seen = new Set<string>();
  for (const wallet of wallets ?? []) {
    if (seen.has(wallet)) continue;
    seen.add(wallet);
    const fee = lookupOtcDeskFee(fees, wallet);
    if (fee) return fee;
  }
  return null;
}

/** Coins in a GET /api/coins body: a list, or `coins` / `data` / `tokens` / `items` / `featured`. */
export function otcRosterCoins(body: unknown): unknown[] | null {
  return rosterCoins(body);
}

const COIN_LIST_KEYS = ["coins", "data", "tokens", "items", "results", "featured"] as const;

function rosterCoins(body: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object" || depth > 2) return null;
  const record = body as Record<string, unknown>;
  for (const key of COIN_LIST_KEYS) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  for (const key of ["data", "result", "payload"] as const) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const coins = rosterCoins(nested, depth + 1);
      if (coins) return coins;
    }
  }
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
  // A wallet listed on exactly one rewarded coin matches a pump creator-fee destination.
  // The same wallet on two coins is not a desk: attaching either basket would be a guess.
  const aliasToMints = new Map<string, string[]>();
  for (const coin of coins) {
    if (!coin || typeof coin !== "object" || Array.isArray(coin)) continue;
    const mint = mintOf((coin as { mint?: unknown }).mint);
    if (!mint || !fees.has(mint)) continue;
    for (const addr of walletAddressesOn(coin)) {
      if (addr === mint) continue;
      const list: string[] = aliasToMints.get(addr) ?? [];
      if (!list.includes(mint)) list.push(mint);
      aliasToMints.set(addr, list);
    }
  }
  for (const [addr, mints] of aliasToMints) {
    if (mints.length !== 1 || fees.has(addr)) continue;
    const fee = fees.get(mints[0]!);
    if (fee) fees.set(addr, fee);
  }
  return fees;
}
