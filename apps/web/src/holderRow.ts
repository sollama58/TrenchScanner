import { shortAddress, usd } from "./format";
import type { HolderEntry } from "./holderEntry";
import { solText, tokensText } from "./components/TradePanel";
import type { WalletNames } from "./walletNames";

/**
 * Figures for one top-holder row, from numbers the pipeline already has.
 *
 * Native SOL is the wallet's system-account lamports from the holder chain read (one
 * getMultipleAccounts for the list). A streamed token-balance update does not read it again.
 * A miss is left off the row. Zero lamports is a real empty account and is shown.
 */

export interface HolderAverage {
  mcapUsd: number;
  tokens: number;
  sol: number;
}

export interface HolderFunding {
  wallet: string;
  fundedAtMs: number | null;
  /** The funder is the exchange or busy service recorded as cexFunder. */
  cex: boolean;
}

type ListedHolder = {
  wallet: string;
  pct?: number;
  funder?: string;
  fundedAtMs?: number;
  cexFunder?: string;
  portfolioUsd?: number;
  /** Native SOL in lamports from the holder chain read. Absent when that read missed the wallet. */
  solLamports?: number;
};
type SameWallet = { wallet: string; pct?: number; funder: string | null; fundedAtMs: number };

/** Who paid for this holder, from the list, the same-minute group, or the exchange tag. */
export function holderFunding(
  wallet: string,
  snapshot: {
    linkedHolders?: readonly ListedHolder[] | null;
    sameTimeClusters?: readonly { wallets: readonly SameWallet[] }[] | null;
  },
): HolderFunding | null {
  const listed = snapshot.linkedHolders?.find((h) => h.wallet === wallet);
  let same: SameWallet | undefined;
  for (const group of snapshot.sameTimeClusters ?? []) {
    same = group.wallets.find((w) => w.wallet === wallet);
    if (same) break;
  }
  const fromList = listed?.funder;
  const fromSame = same?.funder ?? null;
  const fromCex = listed?.cexFunder;
  const funder = fromList || fromSame || fromCex || null;
  if (!funder) return null;
  const at = listed?.fundedAtMs ?? same?.fundedAtMs;
  return {
    wallet: funder,
    fundedAtMs: typeof at === "number" && Number.isFinite(at) ? at : null,
    cex: !!fromCex && funder === fromCex,
  };
}

/**
 * The funder's label when one is already known (a CEX name, or "Exchange or service" for a hot
 * funder with no name), otherwise the address as its first 4 and last 4 characters.
 */
export function fundingWho(fund: Pick<HolderFunding, "wallet" | "cex">, names: WalletNames): string {
  const named = names[fund.wallet]?.name;
  if (named) return named;
  if (fund.cex) return "Exchange or service";
  return shortAddress(fund.wallet);
}

/** The funding time, in the reader's clock, as the bubble map says a same-minute group. */
export function fundingTime(atMs: number): string {
  return new Date(atMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Binance · Oct 21, 2:00 PM", or the name alone when the time was not kept. */
export function fundingLine(who: string, atMs: number | null): string {
  return atMs === null ? who : `${who} · ${fundingTime(atMs)}`;
}

/**
 * The portfolio already priced for this wallet. Null when the check did not run or left a holding
 * unpriced. A calculated 0 stays 0; a missing field does not become 0.
 */
export function portfolioUsdOf(holder: Pick<ListedHolder, "portfolioUsd"> | undefined): number | null {
  const value = holder?.portfolioUsd;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface TapePosition {
  solIn: number;
  solOut: number;
  /** Absent when the tape row did not carry token amounts. */
  tokensBought: number | null;
  tokensSold: number | null;
}

export interface HolderPrice {
  priceUsd: number;
  marketCapUsd: number;
  solUsd: number;
  /** Current share of supply, in percent. */
  heldPct: number;
}

export interface HolderTradeStats {
  entry: HolderAverage | null;
  exit: HolderAverage | null;
  unrealizedSol: number | null;
  realizedSol: number | null;
}

const EMPTY_TRADE: HolderTradeStats = {
  entry: null,
  exit: null,
  unrealizedSol: null,
  realizedSol: null,
};

/**
 * Average entry and exit market caps, and this coin's unrealized and realized PnL, from the tape
 * and the coin's current price.
 *
 * The average is the tape's own fill: SOL per token, times supply, times the SOL price already in
 * hand (the same definition as the trade panel's entry market cap). Supply is the snapshot's
 * market cap over its token price. A missing price, SOL price, or token amount leaves the average
 * off. Realized PnL needs only the tape. Unrealized needs a current price for the tokens still held
 * that were bought; tokens received by transfer are not given a cost of zero.
 */
export function holderTradeStats(tape: TapePosition | null, price: HolderPrice | null): HolderTradeStats {
  if (!tape || tape.tokensBought === null || tape.tokensSold === null) return EMPTY_TRADE;
  const bought = tape.tokensBought;
  const soldTokens = tape.tokensSold;
  if (!(bought >= 0) || !(soldTokens >= 0)) return EMPTY_TRADE;
  const sold = bought > 0 ? Math.min(soldTokens, bought) : 0;
  const supply =
    price && price.priceUsd > 0 && price.marketCapUsd > 0 ? price.marketCapUsd / price.priceUsd : null;
  const solUsd = price && price.solUsd > 0 ? price.solUsd : null;
  const entry =
    bought > 0 && tape.solIn > 0 && supply !== null && solUsd !== null
      ? { mcapUsd: (tape.solIn / bought) * supply * solUsd, tokens: bought, sol: tape.solIn }
      : null;
  const exit =
    soldTokens > 0 && tape.solOut > 0 && supply !== null && solUsd !== null
      ? { mcapUsd: (tape.solOut / soldTokens) * supply * solUsd, tokens: soldTokens, sol: tape.solOut }
      : null;
  const realizedSol =
    bought > 0 && soldTokens > 0 ? tape.solOut * (sold / soldTokens) - tape.solIn * (sold / bought) : null;
  let unrealizedSol: number | null = null;
  if (bought > 0 && price && price.priceUsd > 0 && solUsd !== null) {
    const remaining = bought - sold;
    const held = Math.max(0, (price.heldPct / 100) * (supply ?? 0));
    const costedHeld = Math.min(held, remaining);
    if (costedHeld > 0)
      unrealizedSol = (costedHeld * price.priceUsd) / solUsd - tape.solIn * (costedHeld / bought);
  }
  return { entry, exit, unrealizedSol, realizedSol };
}

export function tradeStatsFor(entry: HolderEntry | undefined, price: HolderPrice | null): HolderTradeStats {
  if (!entry) return EMPTY_TRADE;
  return holderTradeStats(
    {
      solIn: entry.solIn,
      solOut: entry.solOut,
      tokensBought: entry.tokensBought ?? null,
      tokensSold: entry.tokensSold ?? null,
    },
    price,
  );
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Lamports from one getMultipleAccounts result, lined up with `wallets`.
 * A failed batch (no list, or one that does not line up) and a missing account omit that wallet.
 * An account whose lamports are 0 stays 0.
 */
export function solLamportsByWallet(
  wallets: readonly string[],
  accounts: readonly ({ lamports?: unknown } | null)[] | null | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!accounts || accounts.length !== wallets.length) return out;
  wallets.forEach((wallet, i) => {
    const account = accounts[i];
    if (!wallet || !account) return;
    const lamports = account.lamports;
    if (typeof lamports !== "number" || !Number.isFinite(lamports) || lamports < 0) return;
    out.set(wallet, lamports);
  });
  return out;
}

/** Compact SOL for a holder row. Null when the balance was not read. 0 lamports is "0 SOL". */
export function holderSolText(lamports: number | null | undefined): string | null {
  if (typeof lamports !== "number" || !Number.isFinite(lamports) || lamports < 0) return null;
  const sol = lamports / LAMPORTS_PER_SOL;
  const digits = sol < 1 ? 3 : sol < 100 ? 2 : 1;
  const text = sol.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
  return `${text} SOL`;
}

/** One row's lines. A missing figure is left out; nothing here is a dash or a stand-in zero. */
export function holderStatLines(input: {
  portfolioUsd: number | null;
  /** Native lamports. Null or absent: the batch missed this wallet. 0 is a real empty account. */
  solLamports?: number | null;
  entry: HolderAverage | null;
  exit: HolderAverage | null;
  unrealizedSol: number | null;
  realizedSol: number | null;
}): string[] {
  const lines: string[] = [];
  const sol = holderSolText(input.solLamports);
  if (sol !== null) lines.push(sol);
  if (input.portfolioUsd !== null) lines.push(`Portfolio ${usd(input.portfolioUsd)}`);
  if (input.entry)
    lines.push(
      `Entry ${usd(input.entry.mcapUsd)} · ${tokensText(input.entry.tokens)} tokens · ${solText(input.entry.sol)}`,
    );
  if (input.exit)
    lines.push(
      `Exit ${usd(input.exit.mcapUsd)} · ${tokensText(input.exit.tokens)} tokens · ${solText(input.exit.sol)}`,
    );
  const pnl = [
    input.unrealizedSol !== null ? `${solText(input.unrealizedSol, true)} unrealized` : null,
    input.realizedSol !== null ? `${solText(input.realizedSol, true)} realized` : null,
  ].filter((part): part is string => part !== null);
  if (pnl.length > 0) lines.push(pnl.join(" · "));
  return lines;
}
