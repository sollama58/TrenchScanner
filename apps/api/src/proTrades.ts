import {
  createLogger,
  keysOf,
  prisma,
  STREAM_SETTLE_MS,
  tokenAccountRent,
  type ChainTx,
  walletTag,
} from "@trenchscanner/core";

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
/**
 * Pages of CATCH_UP_SIGNATURES a catch-up reads back at most to find its cursor: a wallet away
 * for a while (or one sprayed with dust transfers) has more than one page of new signatures, and
 * reading only the newest page would skip the trades between it and the cursor for good.
 */
export const CATCH_UP_PAGES = 4;
/** Reads of a transaction the RPC won't serve before the catch-up stops waiting on it. */
const UNSERVED_TRIES = 3;
/** Wallets' in-memory pacing entries this stale are dropped (lastCatchUp, scans). */
const PACING_STALE_MS = 3_600_000;

export interface SeenTrade {
  signature: string;
  mint: string;
  /** "out": the coin left the wallet with nothing paid for it (sent to another wallet). */
  side: "buy" | "sell" | "out";
  /**
   * The wallet's SOL change, lamports (wrapped SOL and fees in, token-account rent out); null when
   * paid in USDC/USDT, and for a coin sent out.
   */
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
 * without a price paid (an airdrop, a transfer it sent itself) is left out too. A coin out with
 * nothing paid for it is kept as "out": the position no longer holds it, though nothing was sold.
 *
 * The SOL is what the trade really cost or paid: network, priority and platform fees and slippage
 * are all in the wallet's SOL change. The rent of a token account opened or closed with it is
 * not: it is a deposit the wallet gets back (tokenAccountRent in core).
 */
export function walletSwaps(signature: string, tx: WalletTx, wallet: string, seenAt: number): SeenTrade[] {
  const meta = tx.meta;
  if (!meta || meta.err != null) return [];
  const keys = keysOf(tx);
  if (keys[0] !== wallet) return [];
  const pre = meta.preBalances?.[0];
  const post = meta.postBalances?.[0];
  let landed = typeof pre === "number" && typeof post === "number" ? BigInt(post) - BigInt(pre) : 0n;
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
  landed += deltas.get(WSOL)?.raw ?? 0n;
  const lamports = landed + tokenAccountRent(meta, wallet);
  const stable = [...deltas].some(([m, d]) => m !== WSOL && QUOTE_MINTS.has(m) && d.raw !== 0n);
  const coins = [...deltas].filter(([m, d]) => !QUOTE_MINTS.has(m) && d.raw !== 0n);
  if (coins.length === 0) return [];
  const at = new Date(typeof tx.blockTime === "number" ? tx.blockTime * 1000 : seenAt);
  const out: SeenTrade[] = [];
  for (const [mint, d] of coins) {
    const buy = d.raw > 0n;
    // Paid in SOL when the SOL moved the right way by more than fees; else in a stablecoin, or not
    // paid at all. A sale is told by the SOL as it landed: a dust sale's rent back shows it was paid.
    const solPaid = buy ? -lamports > FEE_ONLY_LAMPORTS : landed > 0n;
    if (!solPaid && !stable) {
      if (!buy)
        out.push({ signature, mint, side: "out", lamports: null, tokens: d.raw, decimals: d.decimals, at });
      continue;
    }
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
    before?: string,
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
  /** Reads of a signature the RPC returned nothing for, so one it never serves can't hold the cursor. */
  private readonly unserved = new Map<string, number>();
  /** Each wallet's writes, one at a time: an entry is decided from the trades written before it. */
  private readonly writes = new Map<string, Promise<void>>();
  private lastPrune = 0;

  constructor(
    private readonly deps: {
      /** Null without a Helius key or a WebSocket: the catch-up alone, on its uncovered pace. */
      stream: TradeStream | null;
      rpc: TradeRpc;
      onEntry: OnEntry;
      /** A new trade was written for the wallet (its positions changed). */
      onRecorded?: (wallet: string) => void;
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
    // Re-set on every touch, so the oldest key in the map is the least recently followed one.
    this.walletOfKey.delete(key);
    this.walletOfKey.set(key, wallet);
    if (this.walletOfKey.size > 10_000) this.walletOfKey.delete(this.walletOfKey.keys().next().value!);
    this.prune(now);
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
    const first = await this.deps.rpc.getSignaturesForAddress(wallet, CATCH_UP_SIGNATURES);
    if (!first) return;
    const cursor = await prisma.proTradeCursor.findUnique({ where: { wallet } });
    const now = this.now();
    let list = first;
    let fresh: typeof list;
    if (cursor?.lastSignature) {
      let at = list.findIndex((s) => s.signature === cursor.lastSignature);
      // Page back until the cursor turns up (or the pages run out, or the wallet's history does).
      for (
        let page = 1;
        at < 0 && page < CATCH_UP_PAGES && list.length === page * CATCH_UP_SIGNATURES;
        page++
      ) {
        const older = await this.deps.rpc.getSignaturesForAddress(
          wallet,
          CATCH_UP_SIGNATURES,
          list[list.length - 1]!.signature,
        );
        if (!older || older.length === 0) break;
        list = [...list, ...older];
        at = list.findIndex((s) => s.signature === cursor.lastSignature);
      }
      // Not found within the pages: everything read is new. Reading only the first page here
      // moved the cursor past the rest, and those trades were never recorded (positions stuck
      // open). Older gaps are filled per coin by the balance check (routes/proTrades.ts).
      fresh = at >= 0 ? list.slice(0, at) : list;
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
        // One the RPC still won't serve after a few reads is left behind rather than re-read forever.
        if (!tx || typeof tx !== "object") {
          const tries = (this.unserved.get(s.signature) ?? 0) + 1;
          if (tries < UNSERVED_TRIES) {
            this.unserved.set(s.signature, tries);
            blocked = true;
          } else {
            this.unserved.delete(s.signature);
            logger.warn("gave up on a transaction the RPC won't serve", { wallet: walletTag(wallet) });
            if (!blocked) newest = s.signature;
          }
          continue;
        }
        this.unserved.delete(s.signature);
        this.remember(s.signature);
        const trades = walletSwaps(s.signature, tx as WalletTx, wallet, (s.blockTime ?? now / 1000) * 1000);
        if (trades.length > 0) await this.record(wallet, trades);
        if (!blocked) newest = s.signature;
      }
    }
    // A failed transaction is never read, but it still moves the cursor when it is the newest.
    if (!blocked && fresh.length > 0) newest = fresh[0]!.signature;
    if (this.unserved.size > SEEN_MAX) this.unserved.clear();
    else if (!cursor && newest === null && list.length > 0 && fresh.length === 0) newest = list[0]!.signature;
    await prisma.proTradeCursor.upsert({
      where: { wallet },
      update: { lastSignature: newest, readAt: new Date(now) },
      create: { wallet, lastSignature: newest, readAt: new Date(now) },
    });
  }

  /**
   * Writes new trades; a buy from a flat position is an entry, and its coin is scanned. One
   * wallet's writes run one after another (the stream and a catch-up can both be writing), so two
   * buys of one coin can't each see the other unwritten and both count as the entry.
   */
  record(wallet: string, trades: SeenTrade[]): Promise<void> {
    const prev = this.writes.get(wallet) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.write(wallet, trades));
    const tail = run.catch(() => undefined);
    this.writes.set(wallet, tail);
    void tail.then(() => {
      if (this.writes.get(wallet) === tail) this.writes.delete(wallet);
    });
    return run;
  }

  private async write(wallet: string, trades: SeenTrade[]): Promise<void> {
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
      if (written.count > 0) this.deps.onRecorded?.(wallet);
      if (written.count > 0 && entry && this.mayScan(wallet)) {
        // Marked first: the worker's TokenSage read follows only scanned entries, so the hourly
        // cap here holds for it too (apps/worker tokensage/utilityLookups.ts).
        await prisma.proTrade.updateMany({
          where: { wallet, signature: t.signature, mint: t.mint },
          data: { scanned: true },
        });
        // No mint beside the tag: a coin and a time would name the wallet from the chain.
        await this.deps
          .onEntry(wallet, t.mint, t.at)
          .catch((err: unknown) =>
            logger.warn("failed to scan a traded coin", { wallet: walletTag(wallet), error: String(err) }),
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

  /** Drops the pacing of wallets nobody has followed for an hour (at most once a minute). */
  private prune(now: number): void {
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    for (const [wallet, at] of this.lastCatchUp)
      if (now - at > PACING_STALE_MS) this.lastCatchUp.delete(wallet);
    for (const [wallet, times] of this.scans) {
      if (times.every((t) => now - t > PACING_STALE_MS)) this.scans.delete(wallet);
    }
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

/**
 * One coin's trade: from a buy into a flat position until it is sold out again. Its cost is the
 * average cost of the coins bought (fees and slippage in): a sale realizes what it got less what
 * the coins it sold cost, and the coins still held carry the rest of the cost.
 */
export interface Position {
  mint: string;
  entryAt: Date;
  lastTradeAt: Date;
  buys: number;
  sells: number;
  /** SOL spent on the buys and got from the sales, in SOL; null parts (stablecoin trades) left out. */
  spentSol: number;
  gotSol: number;
  /** Coins bought and still held (what was bought less what was sold or sent out), whole coins. */
  bought: number;
  held: number;
  decimals: number;
  /** Sold down to under 1% of what was bought. */
  closed: boolean;
  /** The average fill, SOL per whole coin across the buys; null when a buy was paid in a stablecoin. */
  entryPriceSol: number | null;
  /** Every buy and sale has its SOL: false when one was paid in a stablecoin, so no SOL result. */
  priced: boolean;
  /** What the sales made over what the coins they sold cost, SOL. */
  realizedSol: number;
  /** The cost of the coins still held, SOL, and how many of them have one (whole coins). */
  costSol: number;
  costedHeld: number;
  /** What went in for the coins traded or held: the buys, less the cost of coins sent out. */
  investedSol: number;
}

const LAMPORTS_PER_SOL = 1e9;

function whole(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

const sideOrder = (side: string) => (side === "buy" ? 0 : 1);

/** One coin's trade from its rows, oldest first. */
function positionOf(mint: string, trade: readonly TradeRow[]): Position {
  let spent = 0;
  let got = 0;
  let bought = 0n;
  let gone = 0n;
  let buys = 0;
  let sells = 0;
  let priced = true;
  // The average-cost book, in raw coins: those bought with a known cost, and those without one.
  let costed = 0;
  let uncosted = 0;
  let cost = 0;
  let realized = 0;
  let sentCost = 0;
  let costedBought = 0;
  /** Takes `raw` coins out of the book; the share of them that had a cost, and what that cost. */
  const take = (raw: number) => {
    const total = costed + uncosted;
    const n = Math.min(raw, total);
    if (n <= 0) return { share: 0, cost: 0 };
    const fromCosted = (n * costed) / total;
    const out = costed > 0 ? (cost * fromCosted) / costed : 0;
    costed -= fromCosted;
    uncosted -= n - fromCosted;
    cost -= out;
    return { share: fromCosted / raw, cost: out };
  };
  for (const r of trade) {
    const sol = r.lamports === null ? null : Number(r.lamports) / LAMPORTS_PER_SOL;
    if (r.side === "buy") {
      buys += 1;
      bought += r.tokens;
      if (sol === null) {
        priced = false;
        uncosted += Number(r.tokens);
      } else {
        spent += -sol;
        cost += -sol;
        costed += Number(r.tokens);
        costedBought += Number(r.tokens);
      }
    } else if (r.side === "sell") {
      sells += 1;
      gone += -r.tokens;
      const out = take(Number(-r.tokens));
      if (sol === null) priced = false;
      else {
        got += sol;
        // Only the coins with a cost realize anything: proceeds for coins bought before the watch
        // (or sold beyond what was bought) have nothing to be measured against.
        realized += sol * out.share - out.cost;
      }
    } else {
      // Sent out: off the book at their cost, which leaves what went in. Nothing is realized.
      gone += -r.tokens;
      sentCost += take(Number(-r.tokens)).cost;
    }
  }
  const decimals = trade[trade.length - 1]!.decimals;
  const heldRaw = bought > gone ? bought - gone : 0n;
  const avg = costedBought > 0 ? spent / (costedBought / 10 ** decimals) : null;
  return {
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
    closed: bought > 0n ? heldRaw * 100n < bought : true,
    entryPriceSol: priced && avg !== null && avg > 0 ? avg : null,
    priced,
    realizedSol: realized,
    costSol: Math.max(0, cost),
    costedHeld: Math.max(0, costed) / 10 ** decimals,
    investedSol: Math.max(0, spent - sentCost),
  };
}

/**
 * Every trade of every coin, newest entry first. A coin's rows split into trades at each buy into
 * a sold-out position (under 1% left), so a coin traded twice is two trades, each with its own
 * cost and result. A coin first seen mid-position (bought before the watch) starts at its first
 * row; coins only ever sent out (an airdrop passed on) are no trade at all. Rows in any order.
 */
export function tradesOf(rows: readonly TradeRow[]): Position[] {
  const byMint = new Map<string, TradeRow[]>();
  for (const r of rows) byMint.set(r.mint, [...(byMint.get(r.mint) ?? []), r]);
  const out: Position[] = [];
  for (const [mint, list] of byMint) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime() || sideOrder(a.side) - sideOrder(b.side));
    let current: TradeRow[] = [];
    let bought = 0n;
    let held = 0n;
    const flush = () => {
      if (current.some((r) => r.side !== "out")) out.push(positionOf(mint, current));
    };
    for (const r of list) {
      const flat = bought > 0n ? held * 100n < bought : true;
      if (r.side === "buy" && flat && current.length > 0) {
        flush();
        current = [];
        bought = 0n;
        held = 0n;
      }
      current.push(r);
      if (r.side === "buy") bought += r.tokens;
      held += r.tokens;
      if (held < 0n) held = 0n;
    }
    if (current.length > 0) flush();
  }
  return out.sort((a, b) => b.entryAt.getTime() - a.entryAt.getTime());
}

/** Each coin's current trade (its latest), newest entry first. Rows in any order. */
export function positionsOf(rows: readonly TradeRow[]): Position[] {
  const seen = new Set<string>();
  return tradesOf(rows).filter((p) => !seen.has(p.mint) && !!seen.add(p.mint));
}

/**
 * A position's result in SOL: what its sales realized, plus the coins still held at `priceSol`
 * against what they cost; and that as a share of what went in. A sold-out position's dust is
 * worth nothing. Null when a trade was paid in a stablecoin, or an open one can't be priced.
 */
export function positionPnl(
  p: Position,
  priceSol: number | null,
): { sol: number; pct: number; realizedSol: number; unrealizedSol: number } | null {
  if (!p.priced || !(p.investedSol > 0)) return null;
  const holding = !p.closed && p.costedHeld > 0;
  if (holding && priceSol === null) return null;
  const unrealizedSol = (holding ? p.costedHeld * (priceSol ?? 0) : 0) - p.costSol;
  const sol = p.realizedSol + unrealizedSol;
  return { sol, pct: (sol / p.investedSol) * 100, realizedSol: p.realizedSol, unrealizedSol };
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
  /** What the sales made over what the coins sold cost, closed trades and open ones' partial sales, SOL. */
  realizedSol: number;
  /** The coins still held at today's prices against what they cost, SOL; null when any couldn't be priced. */
  unrealizedSol: number | null;
  /** The best closed trade, as a multiple of what it spent. */
  bestMultiple: number | null;
  /** Median minutes from entry to the last sale, closed trades. */
  medianHoldMinutes: number | null;
  /** Of the coins entered, how many TrenchScanner had called before the buy. */
  calledFirst: number;
  entries: number;
}

/** `rows` are the window's trades; `positions` every trade (tradesOf) that ran in it. */
export function tradeStats(
  rows: readonly TradeRow[],
  positions: readonly Position[],
  priceSol: (mint: string) => number | null,
  calledBefore: (mint: string, at: Date) => boolean,
  hours: number,
): TradeStats {
  const closed = positions.filter((p) => p.closed && p.investedSol > 0 && p.priced);
  const open = positions.filter((p) => !p.closed);
  const results = closed
    .map((p) => positionPnl(p, null))
    .filter((r): r is NonNullable<ReturnType<typeof positionPnl>> => !!r);
  let realized = results.reduce((s, r) => s + r.sol, 0);
  let unrealized: number | null = 0;
  for (const p of open) {
    // A stablecoin trade has no SOL result to add, either way.
    if (!p.priced || !(p.investedSol > 0)) continue;
    realized += p.realizedSol;
    const r = positionPnl(p, priceSol(p.mint));
    if (r === null) unrealized = null;
    else if (unrealized !== null) unrealized += r.unrealizedSol;
  }
  const holds = closed
    .map((p) => (p.lastTradeAt.getTime() - p.entryAt.getTime()) / 60_000)
    .sort((a, b) => a - b);
  const traded = rows.filter((r) => r.side === "buy" || r.side === "sell");
  const entries = rows.filter((r) => r.entry);
  return {
    hours,
    trades: traded.length,
    buys: traded.filter((r) => r.side === "buy").length,
    sells: traded.filter((r) => r.side === "sell").length,
    coins: new Set(traded.map((r) => r.mint)).size,
    volumeSol: rows.reduce(
      (s, r) => s + (r.side === "buy" && r.lamports !== null ? -Number(r.lamports) / LAMPORTS_PER_SOL : 0),
      0,
    ),
    closed: closed.length,
    open: open.length,
    winRatePct: results.length > 0 ? (results.filter((r) => r.sol > 0).length / results.length) * 100 : null,
    realizedSol: realized,
    unrealizedSol: unrealized,
    bestMultiple: results.length > 0 ? Math.max(...results.map((r) => 1 + r.pct / 100)) : null,
    medianHoldMinutes: holds.length > 0 ? holds[Math.floor(holds.length / 2)]! : null,
    calledFirst: entries.filter((e) => calledBefore(e.mint, e.at)).length,
    entries: entries.length,
  };
}

/**
 * Coins' live USD prices, each reused `ttlMs`, read through `ask` (the Pro cards' livePricesFor,
 * routes/proTrades.ts). A reader waits `waitMs` at most, then has what came back in time. A coin
 * already being asked about joins that ask (misc audit 2026-10-23, A9): a reader's cards and
 * positions poll together, and each asked Jupiter for the same coins at once. Off (`enabled`
 * false): nothing is asked.
 */
export function liveUsdPrices(
  ask: (mints: string[]) => Promise<Map<string, number>>,
  opts: { enabled: boolean; ttlMs: number; waitMs: number; now?: () => number },
): (mints: string[]) => Promise<Map<string, number>> {
  const clock = opts.now ?? Date.now;
  const prices = new Map<string, { at: number; usd: number }>();
  /** Each coin's ask while it is out, shared by the readers who want it meanwhile. */
  const pending = new Map<string, Promise<Map<string, number> | null>>();
  return async (mints) => {
    const now = clock();
    const out = new Map<string, number>();
    const due: string[] = [];
    for (const m of mints) {
      const hit = prices.get(m);
      if (hit && now - hit.at < opts.ttlMs) out.set(m, hit.usd);
      else due.push(m);
    }
    if (due.length === 0 || !opts.enabled) return out;
    const asks = new Set<Promise<Map<string, number> | null>>();
    const fresh: string[] = [];
    for (const m of due) {
      const joined = pending.get(m);
      if (joined) asks.add(joined);
      else fresh.push(m);
    }
    if (fresh.length > 0) {
      const read = ask(fresh).catch(() => null);
      for (const m of fresh) pending.set(m, read);
      void read.finally(() => {
        for (const m of fresh) if (pending.get(m) === read) pending.delete(m);
      });
      asks.add(read);
    }
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), opts.waitMs).unref?.());
    const reads = await Promise.all([...asks].map((read) => Promise.race([read, timeout])));
    const wanted = new Set(due);
    for (const read of reads) {
      for (const [m, usd] of read ?? []) {
        if (!wanted.has(m) || !(usd > 0)) continue;
        out.set(m, usd);
        prices.set(m, { at: now, usd });
      }
    }
    if (prices.size > 5_000) prices.clear();
    return out;
  };
}
