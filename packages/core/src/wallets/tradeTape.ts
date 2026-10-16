import { isWalletAddress } from "../solana.js";
import type { RawLaunchTx } from "../datasources/launchBuyers.js";

/**
 * A coin's trade tape: every buy and sell from its launch to 30 minutes past the moment a seat
 * called it, and what each wallet did in it. The red-flags study (notes/hit-catch-2026-10-13/
 * red-flags.md) found the calls that stop out look like the winners on every input recorded at the
 * call, so the signal has to come from who holds and who sells. This file is the pure half: turning
 * a source's answer into trades, trades into per-wallet rows with their roles, and a stopped call's
 * window into its stop cause. apps/worker/src/jobs/tradeTapeJob.ts does the reading and writing.
 */

/** Pump.fun coins mint one billion tokens. */
export const PUMP_SUPPLY_TOKENS = 1_000_000_000;
/** Pump.fun's token decimals, for amounts a source gives in base units without saying. */
const PUMP_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1_000_000_000;

/** The window read past the anchor: the label window (30 minutes), which holds every stop. */
export const TAPE_WINDOW_AFTER_ANCHOR_MS = 30 * 60_000;
/** Bought within this long of the launch: a launch sniper. */
export const LAUNCH_SNIPER_MS = 5_000;
/** The launch's first buyers, as launchSnipers.ts counts them. */
export const TAPE_FIRST_BUYERS = 25;
/** Sold within this long of its own first buy: a fast exit. */
export const FAST_EXIT_MS = 3 * 60_000;
/**
 * Wallets that moved less SOL than this either way, and hold no role, are left out of the stored
 * rows: they are mostly dust and bots, and a row per wallet per coin is the table's whole size.
 * They still count in the stop cause, which is worked out from every trade.
 */
export const TAPE_MIN_SOL = 0.05;

export interface TapeTrade {
  wallet: string;
  side: "buy" | "sell";
  /** SOL paid (a buy) or received (a sell). */
  sol: number;
  /** Whole tokens. */
  tokens: number;
  atMs: number;
  /** Signature, for de-duplication. */
  tx: string;
}

export interface ChainTx extends RawLaunchTx {
  meta?:
    | (NonNullable<RawLaunchTx["meta"]> & {
        preBalances?: number[] | null;
        postBalances?: number[] | null;
        /** The network fee in lamports, priority fee included. */
        fee?: number | null;
      })
    | null;
  transaction?: {
    signatures?: string[];
    message?: {
      accountKeys?: (string | { pubkey?: string })[];
      header?: { numRequiredSignatures?: number };
    };
  } | null;
}

interface RawBalance {
  accountIndex: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}

export function keysOf(tx: ChainTx): string[] {
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
    typeof k === "string" ? k : (k?.pubkey ?? ""),
  );
  const loaded = tx.meta?.loadedAddresses;
  if (loaded) keys.push(...(loaded.writable ?? []), ...(loaded.readonly ?? []));
  return keys;
}

/**
 * The trades in a page of a mint's transactions (Helius getTransactionsForAddress, full details,
 * oldest first). Every wallet whose balance of the mint moved is a trader in that transaction: up
 * is a buy, down a sell. Program accounts (the bonding curve, a pool, a vault) are off the ed25519
 * curve and left out, so the curve never reads as the biggest seller. A token move with nothing
 * paid beside it is a transfer, kept: it changes who holds what.
 *
 * The SOL is what the wallet paid or got for the mint, whatever coin it paid in (paidSol): its
 * lamports, its wrapped SOL, and any other coin that moved the other way, valued in SOL from
 * `solPerUnit` (see counterMints), or the fee payer's when a service wallet paid for it. Pump.fun
 * lets a launch pair with any coin (PUMP, USD1, a tokenized stock, another launch), and routers pay
 * out in USDC: a trade paid in another coin read as ~0 SOL here before (2026-10-16: flagged-wallet
 * SOL read 0 on 75% of coin-paired calls against 24% of SOL-paired ones). A coin `solPerUnit`
 * can't price is left out, so such a trade reads its lamports alone, as before.
 *
 * Also returns the launch, when the page starts at it: the transaction that minted the supply
 * (no balance of the mint before it), its time, and its fee payer, the creator.
 */
export function tradesFromChainTransactions(
  mint: string,
  txs: readonly ChainTx[],
  walletCheck: (address: string) => boolean = isWalletAddress,
  solPerUnit: ReadonlyMap<string, number> = new Map(),
): { trades: TapeTrade[]; launch: { atMs: number | null; creator: string | null } | null } {
  const isWallet = new Map<string, boolean>();
  const wallet = (a: string) => {
    let v = isWallet.get(a);
    if (v === undefined) isWallet.set(a, (v = walletCheck(a)));
    return v;
  };
  const trades: TapeTrade[] = [];
  let launch: { atMs: number | null; creator: string | null } | null = null;
  let first = true;
  for (const tx of txs) {
    if (!tx?.meta || tx.meta.err) continue;
    const keys = keysOf(tx);
    const atMs = typeof tx.blockTime === "number" ? tx.blockTime * 1000 : null;
    const sig = tx.transaction?.signatures?.[0] ?? "";
    const pre = ((tx.meta.preTokenBalances ?? []) as RawBalance[]).filter((b) => b.mint === mint);
    const post = ((tx.meta.postTokenBalances ?? []) as RawBalance[]).filter((b) => b.mint === mint);
    if (first) {
      first = false;
      if (pre.length === 0 && post.length > 0) launch = { atMs, creator: keys[0] || null };
    }
    if (atMs === null) continue;
    const deltas = ownerDeltas(pre, post, (b) => b.owner);
    // Every other coin's moves, by owner then mint: the leg paid or received in something else.
    const other = otherDeltas(tx, mint);
    const traders = [...deltas].filter(([owner, delta]) => delta !== 0 && wallet(owner));
    // A trade a service wallet pays for (a trading bot's relayer, sending the coin to its user's
    // wallet): when exactly one trader paid nothing itself and the fee payer is not a trader, what
    // the fee payer paid or got is that trader's, less the network fee.
    const payer = keys[0];
    const payerIsTrader = payer !== undefined && (deltas.get(payer) ?? 0) !== 0;
    const unpaid = traders.filter(
      ([owner, delta]) => paidSol(tx, keys, other, owner, delta, solPerUnit) === 0,
    );
    for (const [owner, delta] of traders) {
      const side = delta > 0 ? "buy" : "sell";
      let sol = paidSol(tx, keys, other, owner, delta, solPerUnit);
      if (sol === 0 && unpaid.length === 1 && payer && !payerIsTrader) {
        sol = paidSol(tx, keys, other, payer, delta, solPerUnit, (tx.meta.fee ?? 0) / LAMPORTS_PER_SOL);
      }
      trades.push({
        wallet: owner,
        side,
        sol,
        tokens: Math.abs(delta),
        atMs,
        tx: sig,
      });
    }
  }
  return { trades, launch };
}

/**
 * What `owner` paid (for a buy, `delta` > 0) or got (a sell) for the mint in one transaction, in
 * SOL: its lamport change plus `feeBack` (fees and tips are otherwise included, so a buy reads a
 * little dear), its wrapped SOL either way, and each other coin on the leg that went the other way
 * (paid on a buy, got on a sell, so a coin passing through is not a price) valued from
 * `solPerUnit`. A coin it has no price for adds nothing.
 */
function paidSol(
  tx: ChainTx,
  keys: string[],
  other: Map<string, Map<string, number>>,
  owner: string,
  delta: number,
  solPerUnit: ReadonlyMap<string, number>,
  feeBack = 0,
): number {
  const i = keys.indexOf(owner);
  const lamports = i >= 0 ? (tx.meta?.postBalances?.[i] ?? 0) - (tx.meta?.preBalances?.[i] ?? 0) : 0;
  let solIn = lamports / LAMPORTS_PER_SOL + feeBack;
  for (const [coin, moved] of other.get(owner) ?? []) {
    if (coin === WRAPPED_SOL_MINT) solIn += moved;
    else if (delta > 0 ? moved < 0 : moved > 0) solIn += moved * (solPerUnit.get(coin) ?? 0);
  }
  return delta > 0 ? Math.max(0, -solIn) : Math.max(0, solIn);
}

/** Wrapped SOL: counted as SOL wherever a wallet pays or gets it. */
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Each owner's net change in whole tokens across a transaction's token balances. */
function ownerDeltas(
  pre: RawBalance[],
  post: RawBalance[],
  ownerOf: (b: RawBalance) => string | undefined,
): Map<string, number> {
  const deltas = new Map<string, number>();
  const add = (b: RawBalance, sign: 1 | -1) => {
    const owner = ownerOf(b);
    if (!owner) return;
    const raw = Number(b.uiTokenAmount?.amount ?? 0);
    if (!Number.isFinite(raw)) return;
    const tokens = raw / 10 ** (b.uiTokenAmount?.decimals ?? PUMP_DECIMALS);
    deltas.set(owner, (deltas.get(owner) ?? 0) + sign * tokens);
  };
  for (const b of pre) add(b, -1);
  for (const b of post) add(b, 1);
  return deltas;
}

/** Every coin but `mint` that moved in a transaction: owner -> coin -> net whole tokens. */
function otherDeltas(tx: ChainTx, mint: string): Map<string, Map<string, number>> {
  const byCoin = new Map<string, { pre: RawBalance[]; post: RawBalance[] }>();
  const collect = (list: unknown, key: "pre" | "post") => {
    for (const b of (list ?? []) as RawBalance[]) {
      if (!b.mint || b.mint === mint) continue;
      let entry = byCoin.get(b.mint);
      if (!entry) byCoin.set(b.mint, (entry = { pre: [], post: [] }));
      entry[key].push(b);
    }
  };
  collect(tx.meta?.preTokenBalances, "pre");
  collect(tx.meta?.postTokenBalances, "post");
  const out = new Map<string, Map<string, number>>();
  for (const [coin, { pre, post }] of byCoin) {
    for (const [owner, moved] of ownerDeltas(pre, post, (b) => b.owner)) {
      if (moved === 0) continue;
      let coins = out.get(owner);
      if (!coins) out.set(owner, (coins = new Map()));
      coins.set(coin, moved);
    }
  }
  return out;
}

/**
 * The coins, other than SOL, that wallets paid for `mint` or got for it in these transactions:
 * the coin-paired launch's quote coin, or what a router paid out (USDC). Price these in SOL and
 * pass them to tradesFromChainTransactions, so no coin needs to be known in advance.
 */
export function counterMints(
  mint: string,
  txs: readonly ChainTx[],
  walletCheck: (address: string) => boolean = isWalletAddress,
): string[] {
  const coins = new Set<string>();
  for (const tx of txs) {
    if (!tx?.meta || tx.meta.err) continue;
    const pre = ((tx.meta.preTokenBalances ?? []) as RawBalance[]).filter((b) => b.mint === mint);
    const post = ((tx.meta.postTokenBalances ?? []) as RawBalance[]).filter((b) => b.mint === mint);
    const deltas = ownerDeltas(pre, post, (b) => b.owner);
    const other = otherDeltas(tx, mint);
    const payer = keysOf(tx)[0];
    for (const [owner, delta] of deltas) {
      if (delta === 0 || !walletCheck(owner)) continue;
      // The fee payer's too, for a trade it pays for (see tradesFromChainTransactions).
      for (const who of payer && !deltas.get(payer) ? [owner, payer] : [owner]) {
        for (const [coin, moved] of other.get(who) ?? []) {
          if (coin !== WRAPPED_SOL_MINT && Math.sign(moved) === -Math.sign(delta)) coins.add(coin);
        }
      }
    }
  }
  return [...coins];
}

/** Prices coins in SOL per whole token, leaving out any it can't (DexScreenerClient.solPricesOf). */
export type SolPriceLookup = (mints: string[]) => Promise<ReadonlyMap<string, number>>;

/**
 * tradesFromChainTransactions with the coins paid or got beside the mint (counterMints) priced
 * first. Without a lookup, or when it fails, those coins go unvalued as before.
 */
export async function tradesFromChainTransactionsPriced(
  mint: string,
  txs: readonly ChainTx[],
  solPrices?: SolPriceLookup,
  walletCheck: (address: string) => boolean = isWalletAddress,
): Promise<ReturnType<typeof tradesFromChainTransactions>> {
  const coins = solPrices ? counterMints(mint, txs, walletCheck) : [];
  const prices =
    coins.length > 0 ? await solPrices!(coins).catch(() => new Map<string, number>()) : new Map();
  return tradesFromChainTransactions(mint, txs, walletCheck, prices);
}

/** One page of Pump.fun's trade API (swap-api /v2/coins/{mint}/trades), newest first. */
export interface PumpFunTradesPage {
  trades: TapeTrade[];
  /** Pass back as `cursor` for the next (older) page; null when there is none. */
  nextCursor: string | null;
}

/** Parses a Pump.fun trades answer; unusable entries are dropped. */
export function tradesFromPumpFun(body: unknown): PumpFunTradesPage {
  const b = body as { trades?: unknown; pagination?: { nextCursor?: unknown; hasMore?: unknown } } | null;
  const trades: TapeTrade[] = [];
  for (const t of Array.isArray(b?.trades) ? (b.trades as Record<string, unknown>[]) : []) {
    const wallet = typeof t?.userAddress === "string" ? t.userAddress : "";
    const side = t?.type === "buy" || t?.type === "sell" ? t.type : null;
    const atMs = typeof t?.timestamp === "string" ? Date.parse(t.timestamp) : Number.NaN;
    const sol = Number(t?.amountSol);
    const tokens = Number(t?.baseAmount);
    if (!wallet || !side || !Number.isFinite(atMs) || !Number.isFinite(sol) || !Number.isFinite(tokens))
      continue;
    trades.push({ wallet, side, sol: Math.abs(sol), tokens: Math.abs(tokens), atMs, tx: String(t.tx ?? "") });
  }
  const next = b?.pagination?.nextCursor;
  return {
    trades,
    nextCursor: b?.pagination?.hasMore === true && typeof next === "string" && next ? next : null,
  };
}

/** The cursor that starts Pump.fun's trade API at the trades just before `atMs`. */
export function pumpFunCursorBefore(atMs: number): string {
  return `${"9".repeat(26)}-${Math.floor(atMs)}`;
}

export interface TapeContext {
  /** The reference anchor: roles at the anchor (top 10, held) are read here. */
  anchorAtMs: number;
  /** The reference row's stop, when it stopped. */
  stoppedAtMs: number | null;
  /** Whether the trades run from the launch: launch roles need it. */
  complete: boolean;
  launchAtMs: number | null;
  creator: string | null;
  supply?: number;
}

export interface WalletSummary {
  wallet: string;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  tokensBought: number;
  tokensSold: number;
  firstBuyAtMs: number | null;
  firstSellAtMs: number | null;
  heldAtAnchor: number | null;
  heldPctAtAnchor: number | null;
  boughtPct: number;
  isCreator: boolean;
  firstBuyerRank: number | null;
  launchSniper: boolean;
  top10AtAnchor: boolean;
  fastExit: boolean;
  dumpedIntoStop: boolean;
  dumpSol: number;
}

/** Trades oldest first, each once (two sources, or two pages that overlap, can repeat one). */
export function orderTrades(trades: readonly TapeTrade[]): TapeTrade[] {
  const seen = new Set<string>();
  const out: TapeTrade[] = [];
  for (const t of trades) {
    const key = `${t.tx}|${t.wallet}|${t.side}|${t.tokens}`;
    if (t.tx && seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  // Stable: trades in the same second keep the order the source gave (chain order once a
  // newest-first source is reversed by the caller).
  return out
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.atMs - b.t.atMs || a.i - b.i)
    .map((x) => x.t);
}

/**
 * Every wallet's row for a coin, from its trades oldest first (orderTrades). Launch roles (first
 * buyers, snipers) and holdings at the anchor need the whole tape from the launch, so they stay
 * unknown on an incomplete one; what happened after the anchor doesn't.
 */
export function summarizeTape(trades: readonly TapeTrade[], ctx: TapeContext): WalletSummary[] {
  const supply = ctx.supply ?? PUMP_SUPPLY_TOKENS;
  const byWallet = new Map<string, WalletSummary>();
  const held = new Map<string, number>();
  const firstBuyers: string[] = [];
  for (const t of trades) {
    let w = byWallet.get(t.wallet);
    if (!w) {
      w = {
        wallet: t.wallet,
        buys: 0,
        sells: 0,
        solIn: 0,
        solOut: 0,
        tokensBought: 0,
        tokensSold: 0,
        firstBuyAtMs: null,
        firstSellAtMs: null,
        heldAtAnchor: null,
        heldPctAtAnchor: null,
        boughtPct: 0,
        isCreator: ctx.creator !== null && t.wallet === ctx.creator,
        firstBuyerRank: null,
        launchSniper: false,
        top10AtAnchor: false,
        fastExit: false,
        dumpedIntoStop: false,
        dumpSol: 0,
      };
      byWallet.set(t.wallet, w);
    }
    if (t.side === "buy") {
      w.buys += 1;
      w.solIn += t.sol;
      w.tokensBought += t.tokens;
      if (w.firstBuyAtMs === null) {
        w.firstBuyAtMs = t.atMs;
        if (!w.isCreator && firstBuyers.length < TAPE_FIRST_BUYERS) firstBuyers.push(t.wallet);
      }
    } else {
      w.sells += 1;
      w.solOut += t.sol;
      w.tokensSold += t.tokens;
      if (w.firstSellAtMs === null) w.firstSellAtMs = t.atMs;
      if (ctx.stoppedAtMs !== null && t.atMs > ctx.anchorAtMs && t.atMs <= ctx.stoppedAtMs) {
        w.dumpedIntoStop = true;
        w.dumpSol += t.sol;
      }
    }
    if (t.atMs <= ctx.anchorAtMs) {
      held.set(t.wallet, (held.get(t.wallet) ?? 0) + (t.side === "buy" ? t.tokens : -t.tokens));
    }
  }
  if (ctx.complete) {
    firstBuyers.forEach((wallet, i) => (byWallet.get(wallet)!.firstBuyerRank = i + 1));
    const top10 = [...held]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([wallet]) => wallet);
    for (const wallet of top10) byWallet.get(wallet)!.top10AtAnchor = true;
  }
  for (const w of byWallet.values()) {
    w.boughtPct = (w.tokensBought / supply) * 100;
    if (ctx.complete) {
      const h = Math.max(0, held.get(w.wallet) ?? 0);
      w.heldAtAnchor = h;
      w.heldPctAtAnchor = (h / supply) * 100;
      w.launchSniper =
        !w.isCreator &&
        ctx.launchAtMs !== null &&
        w.firstBuyAtMs !== null &&
        w.firstBuyAtMs - ctx.launchAtMs <= LAUNCH_SNIPER_MS;
    }
    w.fastExit =
      w.firstBuyAtMs !== null && w.firstSellAtMs !== null && w.firstSellAtMs - w.firstBuyAtMs <= FAST_EXIT_MS;
  }
  return [...byWallet.values()];
}

/** Whether a wallet's row is worth storing (see TAPE_MIN_SOL). */
export function keepWalletRow(w: WalletSummary): boolean {
  return (
    w.solIn >= TAPE_MIN_SOL ||
    w.solOut >= TAPE_MIN_SOL ||
    w.isCreator ||
    w.firstBuyerRank !== null ||
    w.launchSniper ||
    w.top10AtAnchor
  );
}

/** Trades kept per wallet row (TokenWalletActivity.trades): the first ones, then the last ones. */
export const TAPE_TRADES_PER_WALLET = 200;

/**
 * One stored trade: [time in ms, 1 for a buy or -1 for a sell, SOL, whole tokens]. Compact, as a
 * coin has thousands; enough to put each wallet's buys and sells on a chart.
 */
export type StoredTrade = [atMs: number, side: 1 | -1, sol: number, tokens: number];

/**
 * Each wallet's own trades, oldest first, for its stored row. A wallet with more than
 * TAPE_TRADES_PER_WALLET keeps the first and last halves of them (a bot looping all session).
 */
export function walletTrades(trades: readonly TapeTrade[]): Map<string, StoredTrade[]> {
  const out = new Map<string, StoredTrade[]>();
  for (const t of trades) {
    const row: StoredTrade = [
      t.atMs,
      t.side === "buy" ? 1 : -1,
      Math.round(t.sol * 10_000) / 10_000,
      Math.round(t.tokens),
    ];
    const list = out.get(t.wallet);
    if (list) list.push(row);
    else out.set(t.wallet, [row]);
  }
  const half = TAPE_TRADES_PER_WALLET / 2;
  for (const [wallet, list] of out) {
    if (list.length > TAPE_TRADES_PER_WALLET) out.set(wallet, [...list.slice(0, half), ...list.slice(-half)]);
  }
  return out;
}

/** The roles a seller is counted under, most telling first; each seller counts once, under its first. */
export const STOP_ROLES = ["creator", "launchSnipers", "firstBuyers", "top10", "other"] as const;
export type StopRole = (typeof STOP_ROLES)[number];

export interface StopCause {
  v: 1;
  /** The tape the cause was read from: "done" or "partial" (launch roles unknown). */
  tape: "done" | "partial";
  anchorAt: string;
  stoppedAt: string;
  /** Distinct wallets that sold in the window, and what they sold. */
  sellers: number;
  soldSol: number;
  soldTokens: number;
  /** Each role's share of the SOL sold (0-1, summing to 1 when anything sold). */
  shares: Record<StopRole, number>;
  /** The role with the largest share; null when nothing sold. */
  lead: StopRole | null;
  /** The largest sellers, by SOL. */
  top: { wallet: string; sol: number; tokens: number; role: StopRole }[];
}

function roleOf(w: WalletSummary | undefined): StopRole {
  if (!w) return "other";
  if (w.isCreator) return "creator";
  if (w.launchSniper) return "launchSnipers";
  if (w.firstBuyerRank !== null) return "firstBuyers";
  if (w.top10AtAnchor) return "top10";
  return "other";
}

/**
 * Who sold a stopped row's coin between its anchor and its stop, and each role's share of the
 * selling by SOL. Roles come from the tape's own summary (summarizeTape), read at the tape's
 * reference anchor.
 */
export function stopCauseOf(
  trades: readonly TapeTrade[],
  summaries: ReadonlyMap<string, WalletSummary>,
  window: { anchorAtMs: number; stoppedAtMs: number; complete: boolean },
  topN = 10,
): StopCause {
  const sellers = new Map<string, { sol: number; tokens: number }>();
  for (const t of trades) {
    if (t.side !== "sell" || t.atMs <= window.anchorAtMs || t.atMs > window.stoppedAtMs) continue;
    const s = sellers.get(t.wallet) ?? { sol: 0, tokens: 0 };
    s.sol += t.sol;
    s.tokens += t.tokens;
    sellers.set(t.wallet, s);
  }
  const shares = Object.fromEntries(STOP_ROLES.map((r) => [r, 0])) as Record<StopRole, number>;
  let soldSol = 0;
  let soldTokens = 0;
  const ranked = [...sellers].map(([wallet, s]) => ({ wallet, ...s, role: roleOf(summaries.get(wallet)) }));
  for (const s of ranked) {
    soldSol += s.sol;
    soldTokens += s.tokens;
    shares[s.role] += s.sol;
  }
  let lead: StopRole | null = null;
  for (const r of STOP_ROLES) {
    shares[r] = soldSol > 0 ? shares[r] / soldSol : 0;
    if (soldSol > 0 && (lead === null || shares[r] > shares[lead])) lead = r;
  }
  const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    v: 1,
    tape: window.complete ? "done" : "partial",
    anchorAt: new Date(window.anchorAtMs).toISOString(),
    stoppedAt: new Date(window.stoppedAtMs).toISOString(),
    sellers: sellers.size,
    soldSol: round(soldSol),
    soldTokens: Math.round(soldTokens),
    shares: Object.fromEntries(STOP_ROLES.map((r) => [r, round(shares[r])])) as Record<StopRole, number>,
    lead,
    top: ranked
      .sort((a, b) => b.sol - a.sol)
      .slice(0, topN)
      .map((s) => ({ wallet: s.wallet, sol: round(s.sol), tokens: Math.round(s.tokens), role: s.role })),
  };
}
