import {
  createLogger,
  decodeCurve,
  HeliusAccountStream,
  pumpCurveAddressOf,
  type CurveState,
  type HeliusClient,
} from "@trenchscanner/core";
import type { SolPrice } from "./solPrice.js";

const logger = createLogger("live-curve");

/**
 * The token chart's live tail (user ask 2026-10-17: charts on the stream's second-by-second
 * updates). The worker's curve tape follows every young coin's bonding curve, but in the worker's
 * memory, where the API can't read it. So while a chart is open on a Pump.fun coin still on its
 * curve, the API follows that one curve itself, on its own Helius websocket (accountSubscribe: an
 * update per changed block, ~0.5 KB at 2 credits per 0.1 MB), and the chart polls the changes
 * since its last answer. The curve's reserves are the price exactly, so the tail is every price
 * the coin traded at, to the block, without waiting on Pump.fun's candles.
 *
 * It never pauses on one source: a curve the stream doesn't cover (no stream, a dropped or refused
 * subscription) is read by RPC every READ_EVERY_MS instead, and SOL's price comes from three
 * providers (solPrice.ts). A curve nobody has asked about for IDLE_MS is let go, and the socket
 * closes once nothing is followed, so it costs nothing while no one is looking. Nothing is stored.
 */

/** A curve is let go once no chart has asked about it for this long. */
const IDLE_MS = 30_000;
/** Off the stream, a followed curve is read this often (1 credit per 100 curves a read). */
export const READ_EVERY_MS = 2_000;
/** How much of a curve's changes are kept: the First 15m view's span, with room. */
const KEEP_MS = 20 * 60_000;
const MAX_TICKS = 6_000;
/** Curves followed at once; past it the least recently asked is let go. */
const MAX_FOLLOWED = 200;
/** The socket closes after nothing has been followed for this long. */
const SOCKET_IDLE_MS = 2 * 60_000;
/** An unconfirmed stretch longer than this is a hole: the cover starts again after it. */
const GAP_MS = 15_000;
const KEY_PREFIX = "chart:";
/** How long a chart's first ask waits on the seed read before answering "pending". */
const SEED_WAIT_MS = 2_500;

type Stream = Pick<HeliusAccountStream, "start" | "stop" | "watch" | "unwatch" | "coveredSince">;
type CurveReader = Pick<HeliusClient, "getCurveStatesBatch">;

/** Where the newest prices came from. "pending": asked, not read yet. "none": not a live curve. */
export type LiveSource = "stream" | "rpc" | "pending" | "none";

/** GET /tokens/:mint/chart/live (web TokenChartCard's live tail). */
export interface LiveCurveAnswer {
  mint: string;
  source: LiveSource;
  /** The curve graduated, or the coin has none: the chart stops asking and reads candles. */
  complete: boolean;
  /** The ticks run without a break from here (ms), null with none. */
  coveredFrom: number | null;
  /** The newest moment the price is known current (ms): a change, a read, or the stream's word. */
  readAt: number | null;
  /** Each price change after `after`: [ms, market cap in USD], oldest first. */
  ticks: [number, number][];
}

interface Followed {
  curve: string;
  askedAt: number;
  /** [ms, market cap in SOL] per change. */
  ticks: [number, number][];
  coveredFrom: number | null;
  confirmedAt: number | null;
  readAt: number | null;
  complete: boolean;
  /** The address holds no curve (not a Pump.fun coin) or a curve not quoted in SOL. */
  none: boolean;
}

/**
 * A curve's market cap in SOL: its price (virtual SOL reserve over virtual token reserve, in base
 * units: lamports and 6-decimal tokens) times Pump.fun's one billion supply.
 */
export function curveMcapSol(state: Pick<CurveState, "virtualQuote" | "virtualToken">): number {
  return (state.virtualQuote / state.virtualToken) * 1e6;
}

export interface LiveCurvesDeps {
  /** Opens the websocket on first use; null: RPC reads only. */
  makeStream: ((onAccount: (key: string, data: string) => void) => Stream) | null;
  reader: CurveReader | null;
  solPrice: Pick<SolPrice, "get">;
  now?: () => number;
}

export class LiveCurves {
  private readonly followed = new Map<string, Followed>();
  private stream: Stream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emptySince: number | null = null;
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly deps: LiveCurvesDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The changes after `after` (ms) of `mint`'s curve, following it from now on if it wasn't. */
  async read(mint: string, after: number): Promise<LiveCurveAnswer> {
    const now = this.now();
    let f = this.followed.get(mint);
    if (!f) {
      const curve = pumpCurveAddressOf(mint);
      if (!curve || (!this.deps.reader && !this.deps.makeStream)) return none(mint);
      if (this.followed.size >= MAX_FOLLOWED) this.dropLeastAsked();
      f = {
        curve,
        askedAt: now,
        ticks: [],
        coveredFrom: null,
        confirmedAt: null,
        readAt: null,
        complete: false,
        none: false,
      };
      this.followed.set(mint, f);
      this.ensureRunning();
      // The first answer waits for its seed read (briefly), rather than a round later.
      await Promise.race([this.round(), new Promise((r) => setTimeout(r, SEED_WAIT_MS))]);
    }
    f.askedAt = now;
    if (f.none) return none(mint);
    if (!f.complete) this.stream?.watch(KEY_PREFIX + mint, [f.curve], now, "account");
    const streamed = this.streamCovers(mint, f);
    if (streamed) f.confirmedAt = now;
    const usd = await this.deps.solPrice.get();
    const source: LiveSource = f.readAt === null ? "pending" : streamed ? "stream" : "rpc";
    return {
      mint,
      source: usd === null && source !== "pending" ? "pending" : source,
      complete: f.complete,
      coveredFrom: f.coveredFrom,
      readAt: f.confirmedAt,
      ticks: usd === null ? [] : f.ticks.filter(([t]) => t > after).map(([t, sol]) => [t, sol * usd]),
    };
  }

  /** An account update the stream delivered. */
  onAccount(key: string, data: string): void {
    if (!key.startsWith(KEY_PREFIX)) return;
    const f = this.followed.get(key.slice(KEY_PREFIX.length));
    const state = decodeCurve(data);
    // The stream only says what changed to, never what it was before: a curve not yet read
    // waits for its seed read to open the tape.
    if (!f || !state || f.readAt === null) return;
    this.record(key.slice(KEY_PREFIX.length), f, state, this.now());
  }

  /** How many curves are followed, and how many of them the stream covers (GET /health). */
  stats(): { followed: number; streamed: number } {
    let streamed = 0;
    for (const [mint, f] of this.followed) if (this.streamCovers(mint, f)) streamed += 1;
    return { followed: this.followed.size, streamed };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.stop();
    this.stream = null;
    this.followed.clear();
  }

  /** Visible for tests: one round of letting go, seeding and polling. */
  async round(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      for (const [mint, f] of this.followed) {
        if (now - f.askedAt > IDLE_MS) this.drop(mint);
      }
      if (this.followed.size === 0) {
        this.emptySince ??= now;
        if (now - this.emptySince > SOCKET_IDLE_MS) this.idle();
        return;
      }
      this.emptySince = null;
      const due: string[] = [];
      for (const [mint, f] of this.followed) {
        if (f.none || f.complete) continue;
        const since = this.stream?.coveredSince(KEY_PREFIX + mint, f.curve) ?? null;
        // Streamed: one read after the subscription began, then the stream carries it.
        if (
          since !== null
            ? f.readAt === null || f.readAt < since
            : f.readAt === null || now - f.readAt >= READ_EVERY_MS
        )
          due.push(mint);
      }
      if (due.length === 0 || !this.deps.reader) return;
      for (let i = 0; i < due.length; i += 100) {
        const mints = due.slice(i, i + 100);
        const curves = mints.map((m) => this.followed.get(m)?.curve ?? "");
        const states = await this.deps.reader.getCurveStatesBatch(curves);
        mints.forEach((mint, k) => {
          const f = this.followed.get(mint);
          const state = states.get(curves[k]!);
          if (!f || state === undefined || state === "failed") return;
          if (state === null || !state.quoteIsSol) {
            f.none = true;
            this.stream?.unwatch(KEY_PREFIX + mint);
            return;
          }
          // Stamped with when the read went out: a change the stream delivered meanwhile is newer.
          this.record(mint, f, state, now);
          f.readAt = now;
        });
      }
    } catch (err) {
      logger.warn("curve read failed", { error: String(err) });
    } finally {
      this.busy = false;
    }
  }

  private record(mint: string, f: Followed, state: CurveState, at: number): void {
    const last = f.ticks[f.ticks.length - 1];
    if (last && at < last[0]) return;
    if (f.confirmedAt === null || at - f.confirmedAt > GAP_MS) f.coveredFrom = at;
    f.confirmedAt = Math.max(f.confirmedAt ?? at, at);
    const mcap = curveMcapSol(state);
    if (!last || last[1] !== mcap) f.ticks.push([at, mcap]);
    let cut = 0;
    while (cut < f.ticks.length - 1 && f.ticks[cut]![0] < at - KEEP_MS) cut += 1;
    if (f.ticks.length - cut > MAX_TICKS) cut = f.ticks.length - MAX_TICKS;
    if (cut > 0) f.ticks.splice(0, cut);
    if (state.complete) {
      f.complete = true;
      this.stream?.unwatch(KEY_PREFIX + mint);
    }
  }

  private streamCovers(mint: string, f: Followed): boolean {
    const since = this.stream?.coveredSince(KEY_PREFIX + mint, f.curve) ?? null;
    return since !== null && f.readAt !== null && f.readAt >= since;
  }

  private ensureRunning(): void {
    if (!this.stream && this.deps.makeStream) {
      this.stream = this.deps.makeStream((key, data) => this.onAccount(key, data));
      this.stream.start();
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.round(), 1_000);
      this.timer.unref?.();
    }
  }

  /** Nothing followed for a while: the socket and the timer stop until the next chart. */
  private idle(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.stop();
    this.stream = null;
    this.emptySince = null;
  }

  private drop(mint: string): void {
    this.stream?.unwatch(KEY_PREFIX + mint);
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

function none(mint: string): LiveCurveAnswer {
  return { mint, source: "none", complete: true, coveredFrom: null, readAt: null, ticks: [] };
}

/** The process's live curves: on Helius when there is a key, else nothing to follow. */
export function liveCurvesFor(
  heliusApiKey: string | undefined,
  enabled: boolean,
  reader: CurveReader | null,
  solPrice: Pick<SolPrice, "get">,
): LiveCurves {
  return new LiveCurves({
    makeStream:
      enabled && heliusApiKey
        ? (onAccount) =>
            new HeliusAccountStream(
              HeliusAccountStream.urlFor(heliusApiKey),
              () => {},
              undefined,
              (key, data) => onAccount(key, data),
            )
        : null,
    reader: enabled ? reader : null,
    solPrice,
  });
}

let shared = new LiveCurves({ makeStream: null, reader: null, solPrice: { get: async () => null } });

/** The process's live curves, shared by every chart route (/tokens and /utilities/token). */
export function liveCurves(): LiveCurves {
  return shared;
}

/** Set once at startup (server.ts); tests set their own. */
export function setLiveCurves(curves: LiveCurves): void {
  shared.stop();
  shared = curves;
}
