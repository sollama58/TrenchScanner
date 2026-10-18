import { walletTag } from "./walletTag.js";
import { createLogger, keysOf, prisma, STREAM_SETTLE_MS, type ChainTx } from "@trenchscanner/core";

const logger = createLogger("pro-trades");

/**
 * The TRADES panel's trade watch (user ask 2026-10-18): a Pro Mode wallet's own buys and sells,
 * read from the chain while its owner is signed in, so each coin it buys is scanned (bubble map,
 * holders, TokenSage) by the time the panel shows it.
 *
 * Credits (Helius): the wallet itself is followed on the Helius stream (transactionSubscribe on
 * its address), which bills by bytes received - a swap is a few KB, a few hundredths of a credit -
 * and carries the whole transaction, so a trade costs no read at all. A catch-up read covers what
 * the stream can't: the trades made while the wallet wasn't followed (its owner was away, or the
 * stream dropped). That is one getSignaturesForAddress (1 credit) and one getTransaction (1 credit)
 * per transaction not seen before; the cursor (ProTradeCursor) means no transaction is ever read
 * twice. It runs on the panel's poll, at most every CATCH_UP_UNCOVERED_MS while the stream isn't
 * covering the wallet and every CATCH_UP_COVERED_MS while it is. Nothing is followed for a wallet
 * nobody has signed in with lately: the stream drops a key 15 minutes after its last poll.
 */

const WSOL = "So11111111111111111111111111111111111111112";
/** Coins a trade is paid in rather than traded: a move in one of these is the price side. */
const QUOTE_MINTS = new Set([
  WSOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
/** SOL out no larger than this alongside coins in is a transfer's fees, not a price. */
const FEE_ONLY_LAMPORTS = 50_000n;

/** Signatures read per catch-up, newest first: a few days of a normal trader's activity. */
export const CATCH_UP_SIGNATURES = 25;
/** How far back a wallet's very first catch-up looks: what its panel opens with. */
export const FIRST_LOOK_BACK_MS = 24 * 3_600_000;
export const CATCH_UP_UNCOVERED_MS = 60_000;
export const CATCH_UP_COVERED_MS = 15 * 60_000;
/** Coins put through a scan for one wallet in an hour at most: a bot's churn can't run up the scan. */
export const ENTRY_SCANS_PER_HOUR = 20;

export interface SeenTrade {
  signature: string;
  mint: string;
  side: "buy" | "sell";
  /** The wallet's SOL change, lamports (wrapped SOL and fees in); null when paid in USDC/USDT. */
  lamports: bigint | null;
  tokens: bigint;
  decimals: number;
  at: Date;
}

type Balance = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
};

/** A transaction as the stream (jsonParsed) or getTransaction (json) gives it. */
export type WalletTx = ChainTx & {
  meta?:
    | (NonNullable<ChainTx["meta"]> & {
        preTokenBalances?: Balance[] | null;
        postTokenBalances?: Balance[] | null;
      })
    | null;
};

/**
 * The trades `wallet` made in one transaction: each coin whose balance in the wallet moved
 * against SOL (or USDC/USDT) moving the other way. Only a transaction the wallet paid for: one
 * someone else paid that moved its coins was a transfer or an airdrop, never its trade. A coin in
 * without a price paid (an airdrop, a transfer it sent itself) is left out too.
 */
export function walletSwaps(signature: string, tx: WalletTx, wallet: string, seenAt: number): SeenTrade[] {
  const meta = tx.meta;
  if (!meta || meta.err != null) return [];
  const keys = keysOf(tx);
  if (keys[0] !== wallet) return [];
  const pre = meta.preBalances?.[0];
  const post = meta.postBalances?.[0];
  let lamports = typeof pre === "number" && typeof post === "number" ? BigInt(post) - BigInt(pre) : 0n;
  const deltas = new Map<string, { raw: bigint; decimals: number }>();
  const add = (entries: Balance[] | null | undefined, sign: 1n | -1n) => {
    for (const e of entries ?? []) {
      if (e.owner !== wallet || !e.mint) continue;
      const raw = e.uiTokenAmount?.amount;
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) continue;
      const d = deltas.get(e.mint) ?? { raw: 0n, decimals: e.uiTokenAmount?.decimals ?? 0 };
      d.raw += sign * BigInt(raw);
      if (typeof e.uiTokenAmount?.decimals === "number") d.decimals = e.uiTokenAmount.decimals;
      deltas.set(e.mint, d);
    }
  };
  add(meta.preTokenBalances, -1n);
  add(meta.postTokenBalances, 1n);
  // Wrapped SOL is SOL: a router that wraps and unwraps leaves it in the lamports either way.
  lamports += deltas.get(WSOL)?.raw ?? 0n;
  const stable = [...deltas].some(([m, d]) => m !== WSOL && QUOTE_MINTS.has(m) && d.raw !== 0n);
  const coins = [...deltas].filter(([m, d]) => !QUOTE_MINTS.has(m) && d.raw !== 0n);
  if (coins.length === 0) return [];
  const at = new Date(typeof tx.blockTime === "number" ? tx.blockTime * 1000 : seenAt);
  const out: SeenTrade[] = [];
  for (const [mint, d] of coins) {
    const buy = d.raw > 0n;
    // Paid in SOL when the SOL moved the right way by more than fees; else in a stablecoin, or not paid at all.
    const solPaid = buy ? -lamports > FEE_ONLY_LAMPORTS : lamports > 0n;
    if (!solPaid && !stable) continue;
    // One coin per transaction is the trade; when several moved the SOL can't be split between them.
    const sol = solPaid && coins.length === 1 ? lamports : null;
    out.push({
      signature,
      mint,
      side: buy ? "buy" : "sell",
      lamports: sol,
      tokens: d.raw,
      decimals: d.decimals,
      at,
    });
  }
  return out;
}

export interface TradeStream {
  watch(key: string, accounts: readonly string[], now?: number): void;
  coveredSince(key: string, account: string): number | null;
  start(): void;
  stop(): void;
}

export interface TradeRpc {
  getSignaturesForAddress(
    address: string,
    limit: number,
  ): Promise<{ signature: string; blockTime: number | null; failed: boolean }[] | null>;
  getTransactionJson(signature: string): Promise<unknown>;
}

/**
 * The stream, open only while some wallet is followed: a Helius connection carries a slot feed as
 * its heartbeat (a few hundred credits a day), so with nobody signed in with Pro Mode there is no
 * connection at all. Opened on the first watch; closed once nothing has been watched for `idleMs`
 * (past the stream's own 15-minute drop of an unwatched key), and opened afresh on the next.
 */
export class LazyTradeStream implements TradeStream {
  private stream: TradeStream | null = null;
  private lastWatch = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly make: () => TradeStream,
    private readonly idleMs = 16 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  watch(key: string, accounts: readonly string[], now = this.now()): void {
    this.lastWatch = now;
    if (!this.stream) {
      this.stream = this.make();
      this.stream.start();
      this.timer = setInterval(() => this.closeIfIdle(), 60_000);
      this.timer.unref?.();
    }
    this.stream.watch(key, accounts, now);
  }

  coveredSince(key: string, account: string): number | null {
    return this.stream?.coveredSince(key, account) ?? null;
  }

  /** Visible for tests. */
  closeIfIdle(now = this.now()): void {
    if (this.stream && now - this.lastWatch >= this.idleMs) this.stop();
  }

  get open(): boolean {
    return this.stream !== null;
  }

  start(): void {}

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.stop();
    this.stream = null;
  }
}

/** Called once per new entry (a buy from a flat position): the coin's scan. */
export type OnEntry = (wallet: string, mint: string, at: Date) => Promise<void>;

/**
 * Users' wallet addresses stay private (user rule 2026-10-18): never in a log line or a stream key
 * (the stream logs its keys). A wallet is named by its one-way tag instead, and the watcher keeps
 * the key-to-wallet map in memory only.
 */
export const streamKey = (wallet: string) => `pro-trades:${walletTag(wallet)}`;
/** Signatures the stream has already delivered, so the catch-up never reads them again. */
const SEEN_MAX = 5_000;

export class ProTradeWatcher {
  private readonly lastCatchUp = new Map<string, number>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly seen = new Set<string>();
  private readonly scans = new Map<string, number[]>();
  /** Stream keys to the wallets they follow (the keys carry only a tag). */
  private readonly walletOfKey = new Map<string, string>();

  constructor(
    private readonly deps: {
      /** Null without a Helius key or a WebSocket: the catch-up alone, on its uncovered pace. */
      stream: TradeStream | null;
      rpc: TradeRpc;
      onEntry: OnEntry;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** What the stream delivers for a followed wallet. */
  onStreamTx(key: string, signature: string, tx: ChainTx): void {
    const wallet = this.walletOfKey.get(key);
    if (!wallet) return;
    this.remember(signature);
    const trades = walletSwaps(signature, tx as WalletTx, wallet, this.now());
    if (trades.length === 0) return;
    void this.record(wallet, trades).catch((err: unknown) =>
      logger.warn("failed to record a streamed trade", { wallet: walletTag(wallet), error: String(err) }),
    );
  }

  /**
   * Keeps the wallet followed, and catches up on what it traded while it wasn't, when that is due.
   * Resolves once the catch-up (if any) is done; the caller may not wait for it.
   */
  touch(wallet: string): Promise<void> {
    const now = this.now();
    const key = streamKey(wallet);
    if (!this.walletOfKey.has(key)) {
      if (this.walletOfKey.size > 10_000) this.walletOfKey.clear();
      this.walletOfKey.set(key, wallet);
    }
    this.deps.stream?.watch(key, [wallet], now);
    const inFlight = this.running.get(wallet);
    if (inFlight) return inFlight;
    const last = this.lastCatchUp.get(wallet);
    const covered = this.deps.stream?.coveredSince(streamKey(wallet), wallet) ?? null;
    // The stream covers everything since it was confirmed; a catch-up read after that (with time
    // to settle) leaves nothing for the next one to find but what the stream missed by a drop.
    const streamCovers = covered !== null && last !== undefined && last >= covered + STREAM_SETTLE_MS;
    const every = streamCovers ? CATCH_UP_COVERED_MS : CATCH_UP_UNCOVERED_MS;
    if (last !== undefined && now - last < every) return Promise.resolve();
    this.lastCatchUp.set(wallet, now);
    const run = this.catchUp(wallet)
      .catch((err: unknown) =>
        logger.warn("trade catch-up failed", { wallet: walletTag(wallet), error: String(err) }),
      )
      .finally(() => this.running.delete(wallet));
    this.running.set(wallet, run);
    return run;
  }

  /** Reads the wallet's signatures newer than its cursor, and records the trades among them. */
  async catchUp(wallet: string): Promise<void> {
    const list = await this.deps.rpc.getSignaturesForAddress(wallet, CATCH_UP_SIGNATURES);
    if (!list) return;
    const cursor = await prisma.proTradeCursor.findUnique({ where: { wallet } });
    const now = this.now();
    let fresh = list;
    if (cursor?.lastSignature) {
      const at = list.findIndex((s) => s.signature === cursor.lastSignature);
      if (at >= 0) fresh = list.slice(0, at);
    } else {
      fresh = list.filter((s) => s.blockTime === null || s.blockTime * 1000 >= now - FIRST_LOOK_BACK_MS);
    }
    // Oldest first, so the cursor only moves past what was read.
    const toRead = fresh.filter((s) => !s.failed).reverse();
    let newest = cursor?.lastSignature ?? null;
    let blocked = false;
    for (let i = 0; i < toRead.length; i += 5) {
      const batch = toRead.slice(i, i + 5);
      const txs = await Promise.all(
        batch.map((s) =>
          this.seen.has(s.signature)
            ? Promise.resolve("seen")
            : this.deps.rpc.getTransactionJson(s.signature),
        ),
      );
      for (let j = 0; j < batch.length; j++) {
        const s = batch[j]!;
        const tx = txs[j];
        if (tx === "seen") {
          if (!blocked) newest = s.signature;
          continue;
        }
        // Not served yet (it just landed): read again next time, and the cursor waits for it.
        if (!tx || typeof tx !== "object") {
          blocked = true;
          continue;
        }
        this.remember(s.signature);
        const trades = walletSwaps(s.signature, tx as WalletTx, wallet, (s.blockTime ?? now / 1000) * 1000);
        if (trades.length > 0) await this.record(wallet, trades);
        if (!blocked) newest = s.signature;
      }
    }
    // A failed transaction is never read, but it still moves the cursor when it is the newest.
    if (!blocked && fresh.length > 0) newest = fresh[0]!.signature;
    else if (!cursor && newest === null && list.length > 0 && fresh.length === 0) newest = list[0]!.signature;
    await prisma.proTradeCursor.upsert({
      where: { wallet },
      update: { lastSignature: newest, readAt: new Date(now) },
      create: { wallet, lastSignature: newest, readAt: new Date(now) },
    });
  }

  /** Writes new trades; a buy from a flat position is an entry, and its coin is scanned. */
  async record(wallet: string, trades: SeenTrade[]): Promise<void> {
    for (const t of trades) {
      let entry = false;
      if (t.side === "buy") {
        const before = await prisma.proTrade.aggregate({
          where: { wallet, mint: t.mint, at: { lte: t.at }, NOT: { signature: t.signature } },
          _sum: { tokens: true },
        });
        entry = (before._sum.tokens ?? 0n) <= 0n;
      }
      const written = await prisma.proTrade.createMany({
        data: [
          {
            wallet,
            signature: t.signature,
            mint: t.mint,
            side: t.side,
            lamports: t.lamports,
            tokens: t.tokens,
            decimals: t.decimals,
            at: t.at,
            entry,
          },
        ],
        skipDuplicates: true,
      });
      if (written.count > 0 && entry && this.mayScan(wallet)) {
        await this.deps.onEntry(wallet, t.mint, t.at).catch((err: unknown) =>
          logger.warn("failed to scan a traded coin", {
            wallet: walletTag(wallet),
            mint: t.mint,
            error: String(err),
          }),
        );
      }
    }
  }

  private mayScan(wallet: string): boolean {
    const now = this.now();
    const recent = (this.scans.get(wallet) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= ENTRY_SCANS_PER_HOUR) {
      this.scans.set(wallet, recent);
      return false;
    }
    recent.push(now);
    this.scans.set(wallet, recent);
    return true;
  }

  private remember(signature: string): void {
    this.seen.add(signature);
    if (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

// ---- The panel's figures, from the recorded trades ----

export interface TradeRow {
  signature: string;
  mint: string;
  side: string;
  lamports: bigint | null;
  tokens: bigint;
  decimals: number;
  at: Date;
  entry: boolean;
}

/** One coin's current trade: from its latest entry on. */
export interface Position {
  mint: string;
  entryAt: Date;
  lastTradeAt: Date;
  buys: number;
  sells: number;
  /** SOL spent on the buys and got from the sales, in SOL; null parts (stablecoin trades) left out. */
  spentSol: number;
  gotSol: number;
  /** Coins bought and still held (what was bought less what was sold), whole coins. */
  bought: number;
  held: number;
  decimals: number;
  /** Sold down to under 1% of what was bought. */
  closed: boolean;
  /** The entry's fill, SOL per whole coin (its first buy); null when it was paid in a stablecoin. */
  entryPriceSol: number | null;
}

const LAMPORTS_PER_SOL = 1e9;

function whole(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Each coin's current position, newest entry first. Rows in any order. */
export function positionsOf(rows: readonly TradeRow[]): Position[] {
  const byMint = new Map<string, TradeRow[]>();
  for (const r of rows) byMint.set(r.mint, [...(byMint.get(r.mint) ?? []), r]);
  const out: Position[] = [];
  for (const [mint, list] of byMint) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    // From the latest entry; a coin first seen mid-position (its buy was before the watch) starts at its first row.
    let start = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.entry) {
        start = i;
        break;
      }
    }
    const trade = list.slice(start);
    let spent = 0;
    let got = 0;
    let bought = 0n;
    let sold = 0n;
    let buys = 0;
    let sells = 0;
    for (const r of trade) {
      const sol = r.lamports === null ? 0 : Number(r.lamports) / LAMPORTS_PER_SOL;
      if (r.side === "buy") {
        buys += 1;
        bought += r.tokens;
        spent += -sol;
      } else {
        sells += 1;
        sold += -r.tokens;
        got += sol;
      }
    }
    const decimals = trade[trade.length - 1]!.decimals;
    const first = trade.find((r) => r.side === "buy");
    const firstCoins = first ? whole(first.tokens, first.decimals) : 0;
    const entryPriceSol =
      first && first.lamports !== null && firstCoins > 0
        ? -Number(first.lamports) / LAMPORTS_PER_SOL / firstCoins
        : null;
    const heldRaw = bought > sold ? bought - sold : 0n;
    out.push({
      mint,
      entryAt: trade[0]!.at,
      lastTradeAt: trade[trade.length - 1]!.at,
      buys,
      sells,
      spentSol: Math.max(0, spent),
      gotSol: Math.max(0, got),
      bought: whole(bought, decimals),
      held: whole(heldRaw, decimals),
      decimals,
      closed: bought > 0n ? heldRaw * 100n < bought : sold > 0n,
      entryPriceSol: entryPriceSol !== null && entryPriceSol > 0 ? entryPriceSol : null,
    });
  }
  return out.sort((a, b) => b.entryAt.getTime() - a.entryAt.getTime());
}

/** A position's result in SOL: what came back plus what is still held at `priceSol`, less what was spent. */
export function positionPnl(p: Position, priceSol: number | null): { sol: number; pct: number } | null {
  if (!(p.spentSol > 0)) return null;
  if (!p.closed && p.held > 0 && priceSol === null) return null;
  const value = p.gotSol + (p.closed ? 0 : p.held * (priceSol ?? 0));
  const sol = value - p.spentSol;
  return { sol, pct: (sol / p.spentSol) * 100 };
}

export interface TradeStats {
  /** The window the figures cover, hours (24: user decision 2026-10-18). */
  hours: number;
  trades: number;
  buys: number;
  sells: number;
  coins: number;
  /** SOL put into buys. */
  volumeSol: number;
  closed: number;
  open: number;
  /** Of the closed trades, the share that made money; null with none closed. */
  winRatePct: number | null;
  /** Closed trades' result together, SOL. */
  realizedSol: number;
  /** Open trades' result at today's prices, SOL; null when any couldn't be priced. */
  unrealizedSol: number | null;
  /** The best closed trade, as a multiple of what it spent. */
  bestMultiple: number | null;
  /** Median minutes from entry to the last sale, closed trades. */
  medianHoldMinutes: number | null;
  /** Of the coins entered, how many TrenchScanner had called before the buy. */
  calledFirst: number;
  entries: number;
}

export function tradeStats(
  rows: readonly TradeRow[],
  positions: readonly Position[],
  priceSol: (mint: string) => number | null,
  calledBefore: (mint: string, at: Date) => boolean,
  hours: number,
): TradeStats {
  const closed = positions.filter((p) => p.closed && p.spentSol > 0);
  const open = positions.filter((p) => !p.closed);
  const results = closed
    .map((p) => positionPnl(p, null))
    .filter((r): r is { sol: number; pct: number } => !!r);
  let unrealized: number | null = 0;
  for (const p of open) {
    const r = positionPnl(p, priceSol(p.mint));
    if (r === null) {
      if (p.spentSol > 0) unrealized = null;
      continue;
    }
    if (unrealized !== null) unrealized += r.sol;
  }
  const holds = closed
    .map((p) => (p.lastTradeAt.getTime() - p.entryAt.getTime()) / 60_000)
    .sort((a, b) => a - b);
  const entries = rows.filter((r) => r.entry);
  return {
    hours,
    trades: rows.length,
    buys: rows.filter((r) => r.side === "buy").length,
    sells: rows.filter((r) => r.side === "sell").length,
    coins: new Set(rows.map((r) => r.mint)).size,
    volumeSol: rows.reduce(
      (s, r) => s + (r.side === "buy" && r.lamports !== null ? -Number(r.lamports) / LAMPORTS_PER_SOL : 0),
      0,
    ),
    closed: closed.length,
    open: open.length,
    winRatePct: results.length > 0 ? (results.filter((r) => r.sol > 0).length / results.length) * 100 : null,
    realizedSol: results.reduce((s, r) => s + r.sol, 0),
    unrealizedSol: unrealized,
    bestMultiple: results.length > 0 ? Math.max(...results.map((r) => 1 + r.pct / 100)) : null,
    medianHoldMinutes: holds.length > 0 ? holds[Math.floor(holds.length / 2)]! : null,
    calledFirst: entries.filter((e) => calledBefore(e.mint, e.at)).length,
    entries: entries.length,
  };
}
