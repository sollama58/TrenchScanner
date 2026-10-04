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

/** Pump.fun mints are 1B tokens; PumpPortal reports token amounts in whole tokens. */
export const PUMP_TOTAL_SUPPLY = 1_000_000_000;
/** Buys this soon after the launch are the snipers and bundlers. */
export const EARLY_WINDOW_MS = 30_000;
/** The flow window the 5m features summarize - the same span as DexScreener's 5m figures. */
export const FLOW_WINDOW_MS = 5 * 60_000;

/** How many of the launch's first buyers the still-holding count follows. */
export const FIRST_BUYERS = 25;
/** A first buyer left holding under this share of what they bought counts as sold out (dust). */
const HOLDING_DUST_SHARE = 0.01;

const MAX_WINDOW_TRADES = 300;
const MAX_WALLETS_PER_MINT = 300;
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
  at: number;
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
  lastTradeAt: number;
  lastMcapSol: number | null = null;

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

  /** Every tracked mint - what a reconnecting stream resubscribes to. */
  trackedMints(): string[] {
    return [...this.mints.keys()];
  }

  /** A new launch, seen from its create transaction. Returns true when it is newly tracked. */
  launch(l: FlowLaunch): boolean {
    const fresh = !this.mints.has(l.mint);
    const flow = this.ensure(l.mint, l.at);
    flow.launchAt = l.at;
    flow.observedSince = Math.min(flow.observedSince, l.at);
    if (l.creator) {
      flow.creator = l.creator;
      flow.dev = { bought: l.initialBuyTokens ?? 0, sold: 0, balance: l.initialBuyTokens ?? null };
      flow.wallets.set(l.creator, l.at);
    }
    flow.devInitialBuySol = l.initialBuySol ?? null;
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
    if (flow.window.length > MAX_WINDOW_TRADES) flow.window.splice(0, flow.window.length - MAX_WINDOW_TRADES);
  }

  features(mint: string, now: number): TradeFlowFeatures {
    const flow = this.mints.get(mint);
    if (!flow) return { ...EMPTY_TRADE_FLOW };
    const out: TradeFlowFeatures = { ...EMPTY_TRADE_FLOW };

    const since = now - FLOW_WINDOW_MS;
    flow.window = flow.window.filter((w) => w.at >= since);
    // A full five minutes watched, or the token's whole life when we saw it launch - otherwise a
    // half-watched window would read as a quiet one.
    if (flow.observedSince <= since || (flow.launchAt !== null && flow.launchAt <= flow.observedSince)) {
      const span = Math.max(1, Math.min(FLOW_WINDOW_MS, now - flow.observedSince)) / 60_000;
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

    if (flow.launchAt !== null) {
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
      out.devInitialBuySol = flow.devInitialBuySol;
      out.devSoldShare = flow.dev ? soldShare(flow.dev) : null;
      let holding = 0;
      for (const bag of flow.firstBuyers.values()) {
        if (bagBalance(bag) > bag.bought * HOLDING_DUST_SHARE) holding += 1;
      }
      out.firstBuyersHolding = holding;
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
