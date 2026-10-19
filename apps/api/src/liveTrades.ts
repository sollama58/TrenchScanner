import {
  createLogger,
  HeliusAccountStream,
  PUMP_SUPPLY_TOKENS,
  pumpCurveAddressOf,
  pumpSwapPoolOf,
  tradesFromLogs,
  type DecodedTrade,
} from "@trenchscanner/core";
import { MAX_WAIT_MS } from "./liveCurve.js";
import type { SolPrice } from "./solPrice.js";

const logger = createLogger("live-trades");

/**
 * The token page's live trades (user ask 2026-10-19: show the live trades, as long as it doesn't
 * add too much bandwidth): every buy and sell of one coin, with its wallet, side and both sizes, as
 * they land. While a page asks about a coin, the API follows the logs of every transaction that
 * mentions its Pump.fun curve and its PumpSwap pool (two logsSubscribe keys on its own Helius
 * websocket, so bonding doesn't end it), and reads the swap events in them (core's
 * pumpTradeEvents.ts). A trade is one ~6 KB message, nothing comes between trades, and no
 * transaction is fetched; the page long-polls the trades since its last answer, as the chart does
 * its live tail (liveCurve.ts).
 *
 * Only while someone is looking: a coin nobody has asked about for IDLE_MS is let go, at most
 * MAX_FOLLOWED are followed (the least recently asked goes first), and the socket closes once
 * nothing has been followed for SOCKET_IDLE_MS. Nothing is stored: a coin's newest MAX_TRADES are
 * kept in memory while it is followed, and the feed starts when the follow does.
 */

/** A coin is let go once no page has asked about it for this long. */
const IDLE_MS = 30_000;
/** Coins followed at once (two logs keys each); past it the least recently asked is let go. */
const MAX_FOLLOWED = 50;
/** A coin's newest trades kept, and so the most one answer carries. */
export const MAX_TRADES = 200;
/** The socket closes after nothing has been followed for this long. */
const SOCKET_IDLE_MS = 2 * 60_000;
/** How often coins are let go, and held asks told their coin's subscriptions are live. */
const ROUND_MS = 1_000;
/** The stream keys of a followed coin's curve and pool. */
const CURVE_PREFIX = "trades-curve:";
const POOL_PREFIX = "trades-pool:";

type Stream = Pick<HeliusAccountStream, "start" | "stop" | "watch" | "unwatch" | "coveredSince"> &
  Partial<Pick<HeliusAccountStream, "takeStats">>;

/** GET /tokens/:mint/trades/live (the token page's Live trades). */
export interface LiveTradesAnswer {
  /** "live": followed now, trades since `since`; "pending": subscribing; "unavailable": can't follow this coin here. */
  status: "live" | "pending" | "unavailable";
  /** When the follow began (ms epoch): trades before it aren't in the feed. Null unless live. */
  since: number | null;
  /** Pass back as `after`; 0 before any trade. */
  cursor: number;
  /** Oldest first: those after `after` (all kept, up to 200, when after is 0 or absent). */
  trades: LiveTokenTrade[];
  /**
   * Asked with a wait: the answer was held until a trade came (or the wait ran out), so the page
   * can ask again at once. False for an unavailable coin, which isn't worth asking about again soon.
   */
  held: boolean;
}

export interface LiveTokenTrade {
  seq: number;
  sig: string;
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  tokens: number;
  atMs: number;
  /** USD market cap just after the trade, when known. */
  mcapUsd: number | null;
}

/** The trade socket's traffic since this process started, summed over every socket it opened. */
export interface LiveTradesStreamTotals {
  /** 1 while a trade socket is open, else 0. */
  connected: number;
  logsSubscriptions: number;
  logsUpdates: number;
  bytes: number;
  /** Estimated Helius credits (bytes received, plus one per connection opened). */
  credits: number;
  since: string;
}

interface Kept extends DecodedTrade {
  seq: number;
  sig: string;
}

interface Followed {
  curve: string;
  pool: string | null;
  askedAt: number;
  /** Oldest first, at most MAX_TRADES. */
  trades: Kept[];
  /** Signature, wallet and side of each kept trade: a transaction both keys deliver is read once. */
  seen: Set<string>;
  /** Whether the last look found both subscriptions live (a change wakes the held asks). */
  live: boolean;
}

export interface LiveTradesDeps {
  /** Opens the websocket on first use; null: no stream here, every coin is "unavailable". */
  makeStream:
    | ((onLogs: (key: string, signature: string, logs: string[], slot: number | null) => void) => Stream)
    | null;
  solPrice: Pick<SolPrice, "get">;
  now?: () => number;
}

export class LiveTrades {
  private readonly followed = new Map<string, Followed>();
  private stream: Stream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emptySince: number | null = null;
  private readonly now: () => number;
  /** The last trade's seq, over every coin: a cursor only ever grows within this process. */
  private seq = 0;
  private readonly totals = { logsUpdates: 0, bytes: 0, credits: 0 };
  private readonly startedAt: number;
  /** Pages' held asks, by mint: each woken by the coin's next trade (or its subscriptions going live). */
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly deps: LiveTradesDeps) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
  }

  /**
   * `mint`'s trades after `after` (a cursor from an earlier answer), following the coin from now
   * on if it wasn't. With `waitMs` (at most MAX_WAIT_MS), an ask with nothing new is held until the
   * next trade lands, so the page shows it the moment it does; `signal` lets go of it early.
   */
  async read(mint: string, after: number, waitMs = 0, signal?: AbortSignal): Promise<LiveTradesAnswer> {
    const first = await this.answer(mint, after);
    if (waitMs <= 0 || first.status === "unavailable") return first;
    if (first.trades.length > 0 || signal?.aborted) return { ...first, held: true };
    await this.next(mint, Math.min(waitMs, MAX_WAIT_MS), signal);
    return { ...(await this.answer(mint, after)), held: true };
  }

  /** Resolves on `mint`'s next trade or its going live, after `ms`, or when `signal` aborts. */
  private next(mint: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(mint);
      if (!set) this.waiters.set(mint, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        const s = this.waiters.get(mint);
        s?.delete(done);
        if (s && s.size === 0) this.waiters.delete(mint);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      set.add(done);
    });
  }

  private wake(mint: string): void {
    const set = this.waiters.get(mint);
    if (set) for (const done of [...set]) done();
  }

  private async answer(mint: string, after: number): Promise<LiveTradesAnswer> {
    const f = this.follow(mint, this.now());
    if (!f) return { status: "unavailable", since: null, cursor: 0, trades: [], held: false };
    const since = this.coveredSince(mint, f);
    // A cursor from past this process's newest (a restart, another instance) reads as a fresh ask.
    const from = after > this.seq ? 0 : after;
    const fresh = f.trades.filter((t) => t.seq > from);
    const usd = fresh.some((t) => t.priceSol !== null) ? await this.deps.solPrice.get() : null;
    return {
      status: since === null ? "pending" : "live",
      since,
      cursor: f.trades[f.trades.length - 1]?.seq ?? 0,
      trades: fresh.map((t) => ({
        seq: t.seq,
        sig: t.sig,
        wallet: t.wallet,
        side: t.side,
        sol: t.sol,
        tokens: t.tokens,
        atMs: t.atMs,
        mcapUsd: t.priceSol !== null && usd !== null ? t.priceSol * PUMP_SUPPLY_TOKENS * usd : null,
      })),
      held: false,
    };
  }

  /** Starts following `mint` if it wasn't; null when it can't be followed here. */
  private follow(mint: string, now: number): Followed | null {
    let f = this.followed.get(mint);
    if (!f) {
      const curve = pumpCurveAddressOf(mint);
      if (!curve || !this.deps.makeStream) return null;
      if (this.followed.size >= MAX_FOLLOWED) this.dropLeastAsked();
      f = {
        curve,
        pool: pumpSwapPoolOf(mint) ?? null,
        askedAt: now,
        trades: [],
        seen: new Set(),
        live: false,
      };
      this.followed.set(mint, f);
      this.ensureRunning();
    }
    f.askedAt = now;
    this.stream?.watch(CURVE_PREFIX + mint, [f.curve], now, "logs");
    if (f.pool) this.stream?.watch(POOL_PREFIX + mint, [f.pool], now, "logs");
    return f;
  }

  /**
   * From when both of `f`'s subscriptions have been live without a break (ms epoch), or null. A
   * dropped connection starts it over: the trades kept from before stay, but `since` moves on.
   */
  private coveredSince(mint: string, f: Followed): number | null {
    const curve = this.stream?.coveredSince(CURVE_PREFIX + mint, f.curve) ?? null;
    if (!f.pool || curve === null) return curve;
    const pool = this.stream?.coveredSince(POOL_PREFIX + mint, f.pool) ?? null;
    return pool === null ? null : Math.max(curve, pool);
  }

  /** A successful transaction's logs the stream delivered for one of a coin's keys. */
  onLogs(key: string, signature: string, logs: readonly string[]): void {
    const mint = key.startsWith(CURVE_PREFIX)
      ? key.slice(CURVE_PREFIX.length)
      : key.startsWith(POOL_PREFIX)
        ? key.slice(POOL_PREFIX.length)
        : null;
    const f = mint === null ? undefined : this.followed.get(mint);
    if (mint === null || !f) return;
    // One wallet's several swaps of the coin in one transaction (a split route) read as one trade,
    // so signature, wallet and side name a trade.
    const merged = new Map<string, DecodedTrade>();
    for (const t of tradesFromLogs(logs, { mint, pool: f.pool })) {
      const id = `${signature}:${t.wallet}:${t.side}`;
      const prior = merged.get(id);
      merged.set(
        id,
        prior
          ? {
              ...t,
              sol: prior.sol + t.sol,
              tokens: prior.tokens + t.tokens,
              priceSol: t.priceSol ?? prior.priceSol,
            }
          : t,
      );
    }
    let added = false;
    for (const [id, t] of merged) {
      if (f.seen.has(id)) continue;
      f.seen.add(id);
      f.trades.push({ ...t, seq: ++this.seq, sig: signature });
      added = true;
    }
    if (!added) return;
    while (f.trades.length > MAX_TRADES) {
      const old = f.trades.shift()!;
      f.seen.delete(`${old.sig}:${old.wallet}:${old.side}`);
    }
    this.wake(mint);
  }

  /**
   * How many coins are followed, how many of them the stream covers now, and the trade socket's
   * traffic and estimated credits since this process started (GET /health).
   */
  stats(): { followed: number; streamed: number; stream: LiveTradesStreamTotals } {
    let streamed = 0;
    for (const [mint, f] of this.followed) if (this.coveredSince(mint, f) !== null) streamed += 1;
    const live = this.drainStreamStats();
    return {
      followed: this.followed.size,
      streamed,
      stream: {
        connected: live?.connected ?? 0,
        logsSubscriptions: live?.logsSubscriptions ?? 0,
        logsUpdates: this.totals.logsUpdates,
        bytes: this.totals.bytes,
        credits: this.totals.credits,
        since: new Date(this.startedAt).toISOString(),
      },
    };
  }

  /** Folds the open socket's counts since the last call into the process totals. */
  private drainStreamStats() {
    const s = this.stream?.takeStats?.();
    if (!s) return null;
    this.totals.logsUpdates += s.logsUpdates ?? 0;
    this.totals.bytes += s.bytes;
    this.totals.credits += s.credits;
    return s;
  }

  stop(): void {
    for (const mint of [...this.waiters.keys()]) this.wake(mint);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.drainStreamStats();
    this.stream?.stop();
    this.stream = null;
    this.followed.clear();
  }

  /** Visible for tests: one round of letting go, and of waking the asks on coins just gone live. */
  round(): void {
    const now = this.now();
    for (const [mint, f] of this.followed) {
      if (now - f.askedAt > IDLE_MS) {
        this.drop(mint);
        continue;
      }
      const live = this.coveredSince(mint, f) !== null;
      if (live && !f.live) this.wake(mint);
      f.live = live;
    }
    if (this.followed.size > 0) {
      this.emptySince = null;
      return;
    }
    this.emptySince ??= now;
    if (now - this.emptySince > SOCKET_IDLE_MS) this.idle();
  }

  private ensureRunning(): void {
    if (!this.stream && this.deps.makeStream) {
      this.stream = this.deps.makeStream((key, signature, logs) => this.onLogs(key, signature, logs));
      this.stream.start();
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        try {
          this.round();
        } catch (err) {
          logger.warn("live trades round failed", { error: String(err) });
        }
      }, ROUND_MS);
      this.timer.unref?.();
    }
  }

  /** Nothing followed for a while: the socket and the timer stop until the next page. */
  private idle(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.drainStreamStats();
    this.stream?.stop();
    this.stream = null;
    this.emptySince = null;
  }

  private drop(mint: string): void {
    this.wake(mint);
    this.stream?.unwatch(CURVE_PREFIX + mint);
    this.stream?.unwatch(POOL_PREFIX + mint);
    this.followed.delete(mint);
  }

  private dropLeastAsked(): void {
    let oldest: string | null = null;
    let at = Infinity;
    for (const [mint, f] of this.followed)
      if (f.askedAt < at) {
        at = f.askedAt;
        oldest = mint;
      }
    if (oldest !== null) this.drop(oldest);
  }
}

/** The process's live trades: on Helius when there is a key and a WebSocket, else unavailable. */
export function liveTradesFor(
  heliusApiKey: string | undefined,
  enabled: boolean,
  solPrice: Pick<SolPrice, "get">,
): LiveTrades {
  const hasSocket = !!(globalThis as { WebSocket?: unknown }).WebSocket;
  return new LiveTrades({
    makeStream:
      enabled && heliusApiKey && hasSocket
        ? (onLogs) =>
            new HeliusAccountStream(
              HeliusAccountStream.urlFor(heliusApiKey),
              () => {},
              undefined,
              null,
              (key, signature, logs, _bytes, slot) => onLogs(key, signature, logs, slot),
            )
        : null,
    solPrice,
  });
}

let shared = new LiveTrades({ makeStream: null, solPrice: { get: async () => null } });

/** The process's live trades, shared by every route. */
export function liveTrades(): LiveTrades {
  return shared;
}

/** Set once at startup (server.ts); tests set their own. */
export function setLiveTrades(trades: LiveTrades): void {
  shared.stop();
  shared = trades;
}
