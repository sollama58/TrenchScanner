/**
 * Trade-by-trade order flow for the tokens the scan cares about, from the PumpPortal stream
 * (apps/worker/src/discovery/pumpPortalStream.ts). DexScreener's 5m/1h buy and sell COUNTS say
 * nothing about who is buying: fifty buys can be fifty new holders or one bot looping. Seeing
 * every trade with its wallet and size says which, plus what the launch's earliest buyers (the
 * snipers and bundlers) and the dev are doing with their bags.
 *
 * Pure bookkeeping, no IO: the stream feeds trades in, the scan reads features out. Memory is
 * bounded per mint and in total (see the caps below) - the worker has 512MB.
 */

import { FIRST_BUYER_SUPPLY_CUT } from "../datasources/launchBuyers.js";
import type { TapeTrade } from "../wallets/tradeTape.js";

/** Pump.fun mints are 1B tokens; PumpPortal reports token amounts in whole tokens. */
export const PUMP_TOTAL_SUPPLY = 1_000_000_000;
/** Buys this soon after the launch are the snipers and bundlers. */
export const EARLY_WINDOW_MS = 30_000;
/** The flow window the 5m features summarize - the same span as DexScreener's 5m figures. */
export const FLOW_WINDOW_MS = 5 * 60_000;

/** How many of the launch's first buyers the still-holding count follows. */
export const FIRST_BUYERS = 25;
/**
 * How many of the first buyers the launch-buyer fresh-wallet share reads (freshLaunchBuyerPct):
 * the first ten, where a launch bundle sits, at two fifths of the wallet lookups all 25 would cost.
 */
export const FRESH_LAUNCH_BUYERS = 10;
/** A first buyer left holding under this share of what they bought counts as sold out (dust). */
const HOLDING_DUST_SHARE = 0.01;

/** Trades kept per mint for the 5m window; a busier mint's figures cover the span kept - see features. */
const MAX_WINDOW_TRADES = 1_000;
const MAX_WALLETS_PER_MINT = 300;
/**
 * Newest trades kept per mint for the stream page (recentTrades): the size of one Helius
 * getTransactionsForAddress page, which the live tape used to read for the same reading.
 */
export const STREAM_PAGE_TRADES = 100;
/** PumpPortal's `pool` for a Pump.fun bonding curve; "pump-amm" is its graduation pool. */
export const CURVE_VENUE = "pump";
const MAX_EARLY_WALLETS = 100;

export interface FlowTrade {
  mint: string;
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  /** Tokens moved, in whole tokens. */
  tokenAmount?: number;
  /** The trader's balance after the trade, in whole tokens (PumpPortal's newTokenBalance). */
  newTokenBalance?: number;
  marketCapSol?: number;
  /** The trade's signature, when PumpPortal gave one. */
  tx?: string;
  /** PumpPortal's `pool`: "pump" on the bonding curve, "pump-amm" after graduation. */
  venue?: string;
  at: number;
}

/**
 * A coin's newest trades as the stream saw them (TradeFlowBook.recentTrades), in the live tape's
 * shape (wallets/tradeTape.ts TapeTrade): the page the live tape reads for a bonding coin instead
 * of paying Helius for one (user decision 2026-10-24).
 */
export interface StreamTapePage {
  /** Oldest first, at most STREAM_PAGE_TRADES. */
  trades: TapeTrade[];
  /** Since when the stream has followed the coin without a gap: what the page covers. */
  sinceMs: number;
  /** The coin's whole history: its launch was seen, and no stream gap since. */
  complete: boolean;
  /** Still on the bonding curve: its last trade was on it, and no graduation has been seen. */
  bonding: boolean;
}

export interface FlowLaunch {
  mint: string;
  creator?: string;
  /** Tokens the creator bought in the create transaction. */
  initialBuyTokens?: number;
  /** SOL the creator spent in it. */
  initialBuySol?: number;
  marketCapSol?: number;
  at: number;
}

/**
 * What the models read. Every field is null when the tracker didn't see enough to say: the flow
 * fields need five minutes of watching, the early-buyer and dev fields need the launch itself.
 */
export interface TradeFlowFeatures {
  /** Distinct wallets that bought in the last 5 minutes. */
  uniqueBuyers5m: number | null;
  /** Buys per buying wallet - well above 1 is bots looping, not demand. */
  buysPerBuyer5m: number | null;
  avgBuySol5m: number | null;
  /** The biggest buyer's share of the 5m buy volume, 0-1. */
  topBuyerShare5m: number | null;
  /** Share of the 5m buyers who had never traded this token before, 0-1. */
  newBuyerShare5m: number | null;
  /** (SOL bought - SOL sold) over 5 minutes, relative to market cap. */
  netFlow5mToMcap: number | null;
  tradesPerMin5m: number | null;
  /** Wallets other than the dev that bought within 30s of launch - snipers and bundles. */
  earlyBuyerCount: number | null;
  /** What those wallets still hold, as % of supply. */
  earlyBuyerHoldPct: number | null;
  /** Share of what they bought that they have already sold, 0-1. */
  earlyBuyerSoldShare: number | null;
  devInitialBuySol: number | null;
  /** Share of what the dev bought that the dev has sold, 0-1. */
  devSoldShare: number | null;
  /**
   * Of the first FIRST_BUYERS wallets to buy after launch (the dev aside), how many still hold
   * it. Out of firstBuyersSeen, which is under FIRST_BUYERS only while the launch has had fewer
   * buyers than that.
   */
  firstBuyersHolding: number | null;
  firstBuyersSeen: number | null;
  /**
   * Of those first buyers, how many hold FIRST_BUYER_SUPPLY_CUT (0.1%) of the supply or more: the
   * "First buyers holding" the card, the token view and the filters show (user decision
   * 2026-10-16). firstBuyersHolding, the models' input, counts any buyer above dust instead.
   */
  firstBuyersHoldingCut: number | null;
  /**
   * The launch's shape, from the chain read (datasources/launchBuyers.ts launchFigures): % of the
   * supply the first FIRST_BUYERS buyers bought, how many of them bought in the create
   * transaction's own slot (the bundle), and % of the supply the dev bought in the create. Null
   * until the launch has been read, and on a history that doesn't start at a curve launch.
   */
  firstBuyersSupplyPct: number | null;
  launchBundledBuyers: number | null;
  devBuySupplyPct: number | null;
  /**
   * Of the launch's first FRESH_LAUNCH_BUYERS buyers, the % whose wallet was first used within
   * 24h before the launch (the worker's launchBuyerFreshness.ts). Null until every one of them
   * has been read.
   */
  freshLaunchBuyerPct: number | null;
}

export const EMPTY_TRADE_FLOW: TradeFlowFeatures = {
  uniqueBuyers5m: null,
  buysPerBuyer5m: null,
  avgBuySol5m: null,
  topBuyerShare5m: null,
  newBuyerShare5m: null,
  netFlow5mToMcap: null,
  tradesPerMin5m: null,
  earlyBuyerCount: null,
  earlyBuyerHoldPct: null,
  earlyBuyerSoldShare: null,
  devInitialBuySol: null,
  devSoldShare: null,
  firstBuyersHolding: null,
  firstBuyersSeen: null,
  firstBuyersHoldingCut: null,
  firstBuyersSupplyPct: null,
  launchBundledBuyers: null,
  devBuySupplyPct: null,
  freshLaunchBuyerPct: null,
};

interface Bag {
  bought: number;
  sold: number;
  /** Last reported balance, when the stream gave one. */
  balance: number | null;
}

interface WindowTrade {
  at: number;
  buy: boolean;
  sol: number;
  wallet: string;
  /** The wallet's first trade on this mint. */
  first: boolean;
}

class MintFlow {
  observedSince: number;
  launchAt: number | null = null;
  creator: string | null = null;
  devInitialBuySol: number | null = null;
  dev: Bag | null = null;
  readonly early = new Map<string, Bag>();
  /** The first FIRST_BUYERS buying wallets after launch, the dev aside. */
  readonly firstBuyers = new Map<string, Bag>();
  /** wallet -> first trade time, insertion-ordered so the oldest go first when full. */
  readonly wallets = new Map<string, number>();
  window: WindowTrade[] = [];
  /** When the newest trade dropped off a full window buffer was made, if any - see features. */
  droppedThrough: number | null = null;
  lastTradeAt: number;
  lastMcapSol: number | null = null;
  /** When the stream last came back from a disconnect: trades before it may be missing. */
  gapUntil: number | null = null;
  /** The stream dropped while this launch was tracked, so its bags may be missing sells. */
  bagsMissedTrades = false;
  /** The newest STREAM_PAGE_TRADES trades, oldest first - see recentTrades. */
  recent: TapeTrade[] = [];
  /** PumpPortal's `pool` on the last trade, when it gave one. */
  lastVenue: string | null = null;
  /** When the stream saw the coin graduate (a migrate message), if it has. */
  migratedAt: number | null = null;

  constructor(now: number) {
    this.observedSince = now;
    this.lastTradeAt = now;
  }
}

function addToBag(bag: Bag, t: FlowTrade): void {
  const amount = t.tokenAmount ?? 0;
  if (t.side === "buy") bag.bought += amount;
  else bag.sold += amount;
  if (t.newTokenBalance !== undefined) bag.balance = t.newTokenBalance;
}

const bagBalance = (b: Bag) => b.balance ?? Math.max(0, b.bought - b.sold);
const soldShare = (b: { bought: number; sold: number }) =>
  b.bought > 0 ? Math.min(1, b.sold / b.bought) : null;

export interface TradeFlowBookOptions {
  /** Most mints tracked at once; the least recently traded go first beyond it. */
  maxMints?: number;
  /** A mint with no trade for this long is dropped. */
  idleMs?: number;
  /** A launch still under this market cap (SOL) after `launchGraceMs` is dropped - it never took off. */
  minMcapSol?: number;
  launchGraceMs?: number;
}

export class TradeFlowBook {
  private readonly mints = new Map<string, MintFlow>();
  /** Mints the scan asked to keep, with when it last asked. */
  private readonly watched = new Map<string, number>();
  private readonly opts: Required<TradeFlowBookOptions>;

  constructor(opts: TradeFlowBookOptions = {}) {
    this.opts = {
      maxMints: opts.maxMints ?? 600,
      idleMs: opts.idleMs ?? 15 * 60_000,
      minMcapSol: opts.minMcapSol ?? 45,
      launchGraceMs: opts.launchGraceMs ?? 10 * 60_000,
    };
  }

  get size(): number {
    return this.mints.size;
  }

  has(mint: string): boolean {
    return this.mints.has(mint);
  }

  /**
   * Whether the mint has had no trade since `sinceMs`, as far as this book can tell: followed
   * since before it, with no stream gap after it. False for a mint it doesn't follow, so a caller
   * skipping work on a quiet coin never skips one it can't see.
   */
  quietSince(mint: string, sinceMs: number): boolean {
    const flow = this.mints.get(mint);
    if (!flow || flow.observedSince > sinceMs) return false;
    if (flow.gapUntil !== null && flow.gapUntil > sinceMs) return false;
    return flow.lastTradeAt <= sinceMs;
  }

  /** Every tracked mint - what a reconnecting stream resubscribes to. */
  trackedMints(): string[] {
    return [...this.mints.keys()];
  }

  /**
   * The stream reconnected: whatever traded while it was down was never delivered (PumpPortal
   * doesn't replay). Each tracked mint's 5m window stays unknown until it is five minutes past
   * this, and a launch's early-buyer, dev and first-buyer bags may be missing sells for good.
   */
  streamGap(now: number): void {
    for (const flow of this.mints.values()) {
      flow.gapUntil = now;
      if (flow.launchAt !== null) flow.bagsMissedTrades = true;
    }
  }

  /** A new launch, seen from its create transaction. Returns true when it is newly tracked. */
  launch(l: FlowLaunch): boolean {
    const fresh = !this.mints.has(l.mint);
    const flow = this.ensure(l.mint, l.at);
    flow.launchAt = l.at;
    flow.observedSince = Math.min(flow.observedSince, l.at);
    // A repeated create message must not reset a bag that has since seen the dev sell.
    if (l.creator && !flow.dev) {
      flow.creator = l.creator;
      flow.dev = { bought: l.initialBuyTokens ?? 0, sold: 0, balance: l.initialBuyTokens ?? null };
      flow.wallets.set(l.creator, l.at);
    }
    flow.devInitialBuySol ??= l.initialBuySol ?? null;
    if (l.marketCapSol !== undefined) flow.lastMcapSol = l.marketCapSol;
    return fresh;
  }

  /**
   * The scan is interested in these mints (they are in or near the band): track them even without
   * having seen the launch, and keep them while it keeps asking. Returns the newly tracked ones.
   */
  watch(mints: readonly string[], now: number): string[] {
    const added: string[] = [];
    for (const mint of mints) {
      this.watched.set(mint, now);
      if (!this.mints.has(mint)) {
        this.ensure(mint, now);
        added.push(mint);
      }
    }
    return added;
  }

  trade(t: FlowTrade): void {
    const flow = this.mints.get(t.mint);
    if (!flow) return;
    flow.lastTradeAt = t.at;
    if (t.marketCapSol !== undefined) flow.lastMcapSol = t.marketCapSol;

    const first = !flow.wallets.has(t.wallet);
    if (first) {
      if (flow.wallets.size >= MAX_WALLETS_PER_MINT) {
        const oldest = flow.wallets.keys().next().value;
        if (oldest !== undefined) flow.wallets.delete(oldest);
      }
      flow.wallets.set(t.wallet, t.at);
    }

    if (flow.dev && t.wallet === flow.creator) {
      addToBag(flow.dev, t);
    } else {
      // Only counted from a launch we saw: joining later, the first buyers are already unknown.
      const firstBuyer = flow.firstBuyers.get(t.wallet);
      if (firstBuyer) {
        addToBag(firstBuyer, t);
      } else if (t.side === "buy" && flow.launchAt !== null && flow.firstBuyers.size < FIRST_BUYERS) {
        const bag: Bag = { bought: 0, sold: 0, balance: null };
        addToBag(bag, t);
        flow.firstBuyers.set(t.wallet, bag);
      }

      const early = flow.early.get(t.wallet);
      if (early) {
        addToBag(early, t);
      } else if (
        t.side === "buy" &&
        flow.launchAt !== null &&
        t.at - flow.launchAt <= EARLY_WINDOW_MS &&
        flow.early.size < MAX_EARLY_WALLETS
      ) {
        const bag: Bag = { bought: 0, sold: 0, balance: null };
        addToBag(bag, t);
        flow.early.set(t.wallet, bag);
      }
    }

    flow.window.push({ at: t.at, buy: t.side === "buy", sol: t.sol, wallet: t.wallet, first });
    if (flow.window.length > MAX_WINDOW_TRADES) {
      const dropped = flow.window.splice(0, flow.window.length - MAX_WINDOW_TRADES);
      flow.droppedThrough = dropped[dropped.length - 1]!.at;
    }
    if (t.venue !== undefined) flow.lastVenue = t.venue;
    flow.recent.push({
      wallet: t.wallet,
      side: t.side,
      sol: t.sol,
      tokens: t.tokenAmount ?? 0,
      atMs: t.at,
      // Without a signature the trade still needs a key of its own for de-duplication.
      tx: t.tx ?? `stream:${t.mint}:${t.at}:${t.wallet}:${flow.recent.length}`,
    });
    if (flow.recent.length > STREAM_PAGE_TRADES)
      flow.recent.splice(0, flow.recent.length - STREAM_PAGE_TRADES);
  }

  /** The coin graduated (PumpPortal's migrate message): its curve is done, its trades move to the pool. */
  migrated(mint: string, at: number): void {
    const flow = this.mints.get(mint);
    if (flow) flow.migratedAt ??= at;
  }

  /**
   * The coin's newest trades as this book saw them, for the live tape (user decision 2026-10-24:
   * the tape reads the PumpPortal book while a coin bonds, Helius after). Null for a mint it
   * doesn't follow or has no trade for. `sinceMs` is when the coverage starts: the later of when
   * the coin was first followed and the last stream gap; `complete` when the launch itself was
   * seen and no gap has cut the record since.
   */
  recentTrades(mint: string): StreamTapePage | null {
    const flow = this.mints.get(mint);
    if (!flow || flow.recent.length === 0) return null;
    const gapped = flow.gapUntil !== null && flow.gapUntil > flow.observedSince;
    const sinceMs = gapped ? flow.gapUntil! : flow.observedSince;
    const complete = flow.launchAt !== null && flow.launchAt <= flow.observedSince && !gapped;
    const bonding = flow.migratedAt === null && flow.lastVenue === CURVE_VENUE;
    return { trades: flow.recent.filter((t) => t.atMs >= sinceMs), sinceMs, complete, bonding };
  }

  features(mint: string, now: number): TradeFlowFeatures {
    const flow = this.mints.get(mint);
    if (!flow) return { ...EMPTY_TRADE_FLOW };
    const out: TradeFlowFeatures = { ...EMPTY_TRADE_FLOW };

    const since = now - FLOW_WINDOW_MS;
    flow.window = flow.window.filter((w) => w.at >= since);
    // A full five minutes watched, or the token's whole life when we saw it launch - otherwise a
    // half-watched window would read as a quiet one. A stream gap inside the window is the same.
    const watchedThrough =
      flow.observedSince <= since || (flow.launchAt !== null && flow.launchAt <= flow.observedSince);
    if (watchedThrough && (flow.gapUntil === null || flow.gapUntil <= since)) {
      // A full window buffer has dropped its oldest trades: the figures then cover the span from
      // the oldest one kept, not five minutes - dividing by five minutes capped a busy mint's
      // trade rate at MAX_WINDOW_TRADES / 5 a minute.
      const truncated =
        flow.droppedThrough !== null && flow.droppedThrough >= since && flow.window.length > 0;
      const covered = truncated ? now - flow.window[0]!.at : FLOW_WINDOW_MS;
      const span = Math.max(1, Math.min(covered, now - flow.observedSince)) / 60_000;
      const buys = flow.window.filter((w) => w.buy);
      const byWallet = new Map<string, number>();
      let buySol = 0;
      let sellSol = 0;
      const newBuyers = new Set<string>();
      for (const w of flow.window) {
        if (w.buy) {
          buySol += w.sol;
          byWallet.set(w.wallet, (byWallet.get(w.wallet) ?? 0) + w.sol);
          if (w.first) newBuyers.add(w.wallet);
        } else {
          sellSol += w.sol;
        }
      }
      out.uniqueBuyers5m = byWallet.size;
      out.tradesPerMin5m = flow.window.length / span;
      if (buys.length > 0) {
        out.buysPerBuyer5m = buys.length / byWallet.size;
        out.avgBuySol5m = buySol / buys.length;
        out.topBuyerShare5m = buySol > 0 ? Math.max(...byWallet.values()) / buySol : null;
        out.newBuyerShare5m = newBuyers.size / byWallet.size;
      }
      if (flow.lastMcapSol !== null && flow.lastMcapSol > 0) {
        out.netFlow5mToMcap = (buySol - sellSol) / flow.lastMcapSol;
      }
    }

    if (flow.launchAt !== null) out.devInitialBuySol = flow.devInitialBuySol;
    if (flow.launchAt !== null && !flow.bagsMissedTrades) {
      out.earlyBuyerCount = flow.early.size;
      let held = 0;
      let bought = 0;
      let sold = 0;
      for (const bag of flow.early.values()) {
        held += bagBalance(bag);
        bought += bag.bought;
        sold += bag.sold;
      }
      out.earlyBuyerHoldPct = (held / PUMP_TOTAL_SUPPLY) * 100;
      out.earlyBuyerSoldShare = soldShare({ bought, sold });
      out.devSoldShare = flow.dev ? soldShare(flow.dev) : null;
      let holding = 0;
      let holdingCut = 0;
      for (const bag of flow.firstBuyers.values()) {
        if (bagBalance(bag) > bag.bought * HOLDING_DUST_SHARE) holding += 1;
        if (bagBalance(bag) >= PUMP_TOTAL_SUPPLY * FIRST_BUYER_SUPPLY_CUT) holdingCut += 1;
      }
      out.firstBuyersHolding = holding;
      out.firstBuyersHoldingCut = holdingCut;
      out.firstBuyersSeen = flow.firstBuyers.size;
    }
    return out;
  }

  /**
   * Drops what isn't worth following any more and returns those mints, for the stream to
   * unsubscribe: idle mints, launches that never got off the ground, and - beyond the cap - the
   * least recently traded. A mint the scan asked for in the last idle window always stays.
   */
  evict(now: number): string[] {
    const dropped: string[] = [];
    for (const [mint, at] of this.watched) if (now - at > this.opts.idleMs) this.watched.delete(mint);
    for (const [mint, flow] of this.mints) {
      if (this.watched.has(mint)) continue;
      const idle = now - flow.lastTradeAt > this.opts.idleMs;
      const stalled =
        flow.launchAt !== null &&
        now - flow.launchAt > this.opts.launchGraceMs &&
        (flow.lastMcapSol ?? 0) < this.opts.minMcapSol;
      if (idle || stalled) {
        this.mints.delete(mint);
        dropped.push(mint);
      }
    }
    if (this.mints.size > this.opts.maxMints) {
      const byAge = [...this.mints.entries()]
        .filter(([mint]) => !this.watched.has(mint))
        .sort((a, b) => a[1].lastTradeAt - b[1].lastTradeAt);
      for (const [mint] of byAge.slice(0, this.mints.size - this.opts.maxMints)) {
        this.mints.delete(mint);
        dropped.push(mint);
      }
    }
    return dropped;
  }

  private ensure(mint: string, now: number): MintFlow {
    let flow = this.mints.get(mint);
    if (!flow) {
      flow = new MintFlow(now);
      this.mints.set(mint, flow);
    }
    return flow;
  }
}

/** A dev who has sold at least this share of what they bought counts as sold out. */
const DEV_SOLD_OUT_SHARE = 0.99;

/**
 * Whether the dev still holds the token: from the trade stream when it watched the dev's own
 * buys and sells, otherwise from the creator holding on the profile (the chain's read of the dev's
 * launch buy, else RugCheck's creator balance). Null when none knows.
 */
export function resolveDevHolding(token: {
  tradeFlow?: Pick<TradeFlowFeatures, "devSoldShare">;
  creatorHolding?: boolean;
}): boolean | null {
  const soldShare = token.tradeFlow?.devSoldShare ?? null;
  if (soldShare !== null) return soldShare < DEV_SOLD_OUT_SHARE;
  return token.creatorHolding ?? null;
}

/** A trade off the chain (wallets/tradeTape.ts TapeTrade): SOL paid or got, whole tokens. */
export interface ChainFlowTrade {
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  tokens: number;
  atMs: number;
}

/** The order-flow fields a 5m window of trades gives; the launch's bags need the launch itself. */
export const WINDOW_FLOW_FIELDS = [
  "uniqueBuyers5m",
  "buysPerBuyer5m",
  "avgBuySol5m",
  "topBuyerShare5m",
  "newBuyerShare5m",
  "netFlow5mToMcap",
  "tradesPerMin5m",
] as const satisfies readonly (keyof TradeFlowFeatures)[];

/** How many of the newest priced trades the market cap is read from (their median price). */
const MCAP_TRADES = 9;

/**
 * The 5m order-flow fields read from a page of a coin's newest chain trades (the worker's live
 * tape), for a coin the PumpPortal stream doesn't carry trades for: a Stonks coin, on Raydium's
 * LaunchLab and its CPMM pool - and, on PumpPortal's free tier, every coin (the free stream
 * delivers launches and graduations only, so the stream's window is never watched; model audit
 * 2026-10-26, §16). Each trade's SOL is already what was paid in whatever quote coin. Read as the
 * stream's book reads its window, at `now` (when the page was read):
 *
 * - The window is whole when the page reaches back past it, or holds the coin's whole history
 *   (`complete`). A busy coin whose page lies wholly inside the window reads over the span the
 *   page covers instead, as the book does with a full buffer; its new-buyer share is unknown.
 * - The market cap is the median SOL-per-token of the newest trades on a 1B supply, as
 *   PumpPortal's marketCapSol is (Pump.fun and Stonks mints are both 1B).
 *
 * The early-buyer and dev fields stay null: a page of the newest trades says nothing about them
 * unless it is the coin's whole history - chainLaunchBags reads them then.
 */
export function chainWindowFlow(
  trades: readonly ChainFlowTrade[],
  now: number,
  complete: boolean,
): TradeFlowFeatures {
  const out: TradeFlowFeatures = { ...EMPTY_TRADE_FLOW };
  const sorted = trades.filter((t) => t.atMs <= now).sort((a, b) => a.atMs - b.atMs);
  if (sorted.length === 0) {
    // No trade at all yet, from a whole history: a quiet window, not an unknown one.
    if (complete && trades.length === 0) {
      out.uniqueBuyers5m = 0;
      out.tradesPerMin5m = 0;
    }
    return out;
  }
  const since = now - FLOW_WINDOW_MS;
  const oldest = sorted[0]!.atMs;
  const whole = complete || oldest < since;
  // A whole history younger than the window reads over its own life, as the book does from launch.
  const span = Math.max(1, whole ? Math.min(FLOW_WINDOW_MS, now - oldest) : now - oldest) / 60_000;

  const seenBefore = new Set<string>();
  const byWallet = new Map<string, number>();
  const newBuyers = new Set<string>();
  let buys = 0;
  let buySol = 0;
  let sellSol = 0;
  let inWindow = 0;
  for (const t of sorted) {
    const first = !seenBefore.has(t.wallet);
    seenBefore.add(t.wallet);
    if (t.atMs < since) continue;
    inWindow += 1;
    if (t.side === "buy") {
      buys += 1;
      buySol += t.sol;
      byWallet.set(t.wallet, (byWallet.get(t.wallet) ?? 0) + t.sol);
      if (first) newBuyers.add(t.wallet);
    } else {
      sellSol += t.sol;
    }
  }
  out.uniqueBuyers5m = byWallet.size;
  out.tradesPerMin5m = inWindow / span;
  if (buys > 0) {
    out.buysPerBuyer5m = buys / byWallet.size;
    out.avgBuySol5m = buySol / buys;
    out.topBuyerShare5m = buySol > 0 ? Math.max(...byWallet.values()) / buySol : null;
    // A wallet's first trade is only known when the page reaches back before the window.
    out.newBuyerShare5m = whole ? newBuyers.size / byWallet.size : null;
  }
  const prices = sorted
    .filter((t) => t.tokens > 0 && t.sol > 0)
    .slice(-MCAP_TRADES)
    .map((t) => t.sol / t.tokens)
    .sort((a, b) => a - b);
  const mid = prices.length > 0 ? prices[Math.floor(prices.length / 2)]! : null;
  if (mid !== null) out.netFlow5mToMcap = (buySol - sellSol) / (mid * PUMP_TOTAL_SUPPLY);
  return out;
}

/**
 * A coin's trade flow with its 5m fields taken from `window` (chainWindowFlow) instead of the
 * stream's: for a coin the stream doesn't carry, whose stream window would read an empty five
 * minutes as a quiet one. Without a window reading, those fields are unknown.
 */
export function withWindowFlow(
  flow: TradeFlowFeatures | undefined,
  window: TradeFlowFeatures | null,
): TradeFlowFeatures {
  const out: TradeFlowFeatures = { ...(flow ?? EMPTY_TRADE_FLOW) };
  for (const field of WINDOW_FLOW_FIELDS) out[field] = window?.[field] ?? null;
  return out;
}

/** The launch-bag fields a coin's whole chain history gives; see chainLaunchBags. */
export const LAUNCH_BAG_FIELDS = [
  "earlyBuyerCount",
  "earlyBuyerHoldPct",
  "earlyBuyerSoldShare",
  "devSoldShare",
] as const satisfies readonly (keyof TradeFlowFeatures)[];

export type LaunchBags = Pick<TradeFlowFeatures, (typeof LAUNCH_BAG_FIELDS)[number]>;

/**
 * The launch's bags read from a coin's whole chain trade history: a live-tape page that is
 * `complete` (no older page behind it), for a coin whose launch the PumpPortal stream never saw
 * trades of (its free tier delivers launches and graduations only, so these inputs were null on
 * every decision row; model audit 2026-10-26, §16). Read as the stream's book keeps its bags:
 *
 * - The launch is the oldest trade - the dev's create buy when there was one, else the first
 *   buy. Early buyers are the wallets other than the dev whose first trade is a buy within
 *   EARLY_WINDOW_MS of it, the first MAX_EARLY_WALLETS of them; every later trade of theirs goes
 *   on their bag. What they hold is what they bought less what they sold (the chain gives no
 *   running balance here), as % of the supply; their sold share is sold over bought.
 * - The dev is `creator` (the coin's creator wallet off the on-chain profile): its sold share is
 *   sold over bought across the whole history, null when the dev never bought or is unknown.
 *
 * Null for a page that isn't the whole history: a page of the newest trades says nothing about
 * the launch. A whole history with no trade at all is a launch nobody bought: no early buyers.
 */
export function chainLaunchBags(
  trades: readonly ChainFlowTrade[],
  creator: string | null | undefined,
  complete: boolean,
): LaunchBags | null {
  if (!complete) return null;
  const sorted = [...trades].sort((a, b) => a.atMs - b.atMs);
  const launchAt = sorted[0]?.atMs ?? null;
  const early = new Map<string, Bag>();
  const dev: Bag = { bought: 0, sold: 0, balance: null };
  for (const t of sorted) {
    const trade: FlowTrade = {
      mint: "",
      wallet: t.wallet,
      side: t.side,
      sol: t.sol,
      tokenAmount: t.tokens,
      at: t.atMs,
    };
    if (creator && t.wallet === creator) {
      addToBag(dev, trade);
      continue;
    }
    let bag = early.get(t.wallet);
    if (!bag) {
      const earlyBuy =
        t.side === "buy" &&
        launchAt !== null &&
        t.atMs - launchAt <= EARLY_WINDOW_MS &&
        early.size < MAX_EARLY_WALLETS;
      if (!earlyBuy) continue;
      bag = { bought: 0, sold: 0, balance: null };
      early.set(t.wallet, bag);
    }
    addToBag(bag, trade);
  }
  let held = 0;
  let bought = 0;
  let sold = 0;
  for (const bag of early.values()) {
    held += bagBalance(bag);
    bought += bag.bought;
    sold += bag.sold;
  }
  return {
    earlyBuyerCount: early.size,
    earlyBuyerHoldPct: (held / PUMP_TOTAL_SUPPLY) * 100,
    earlyBuyerSoldShare: soldShare({ bought, sold }),
    devSoldShare: creator ? soldShare(dev) : null,
  };
}

/**
 * A coin's trade flow with the launch-bag fields it lacks filled from `bags` (chainLaunchBags).
 * Only the unknown ones: a bag the stream kept from the launch itself, with the dev's balance off
 * each trade, is the exact figure; the chain read stands in where the stream has none.
 */
export function withLaunchBags(
  flow: TradeFlowFeatures | undefined,
  bags: LaunchBags | null,
): TradeFlowFeatures | undefined {
  if (!bags) return flow;
  const out: TradeFlowFeatures = { ...(flow ?? EMPTY_TRADE_FLOW) };
  for (const field of LAUNCH_BAG_FIELDS) out[field] ??= bags[field];
  return out;
}
