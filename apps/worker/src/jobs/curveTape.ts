import {
  CurveTape,
  EMPTY_CURVE_PATH,
  STONKS_LAUNCHPAD,
  createLogger,
  decodeCurve,
  pumpCurveAddressOf,
  type CurvePathFeatures,
  type HeliusClient,
} from "@trenchscanner/core";
import { streamCredits, type HeliusAccountStream } from "../discovery/heliusAccountStream.js";

const logger = createLogger("curve-tape");

/**
 * The curve tape (user ask 2026-10-17: a young coin's first ~15 minutes, as granular as possible,
 * without much database, CPU or Helius): every tracked Pump.fun coin younger than
 * CURVE_TAPE_MAX_AGE_MINUTES has its bonding curve followed on the Helius websocket
 * (accountSubscribe), so each change of its price and reserves lands in core's CurveTape the moment
 * the block confirms. Helius sends at most one update per changed block (~2.5 a second) whatever
 * the number of trades in it, about 0.5 KB each at 2 credits per 0.1 MB: a quiet coin costs
 * nothing, the busiest about 1.5 credits a minute.
 *
 * The stream only speaks on a change, so each curve is read once by RPC when its subscription
 * starts (1 credit per 100 curves) and the tape runs from there. Curves the stream doesn't cover
 * (no stream, a refused subscription, a dropped connection, or the day's credit pace spent) are
 * read every CURVE_TAPE_POLL_SECONDS instead, the CURVE_TAPE_POLL_MAX_MINTS nearest the band
 * first. Nothing is written to the database: the features ride on the decision's row.
 */

export const CURVE_STREAM_KEY_PREFIX = "curve:";

type CurveStream = Pick<HeliusAccountStream, "watch" | "unwatch" | "coveredSince">;
type CurveReader = Pick<HeliusClient, "getCurveStatesBatch">;

export interface CurveTapeConfig {
  maxAgeMinutes: number;
  maxMints: number;
  streamCreditsPerDay: number;
  pollSeconds: number;
  pollMaxMints: number;
}

interface Followed {
  curve: string;
  /** Position in the watchlist's order (near the band first): the polls go to the lowest. */
  rank: number;
  /** When the tape was last read by RPC (ms epoch), null before the first read. */
  readAt: number | null;
}

const tape = new CurveTape();
const followed = new Map<string, Followed>();
/** Mints whose curve address holds no curve (not Pump.fun) or a graduated one: not asked again. */
const done = new Set<string>();
const MAX_DONE = 20_000;

let stream: CurveStream | null = null;
let reader: CurveReader | null = null;
let cfg: CurveTapeConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
/** The stream is off for the rest of the pace: its credits ran past their share of the day. */
let paused = false;
let day = "";
let dayStreamCredits = 0;
let stats = { updates: 0, bytes: 0, readCalls: 0, curvesRead: 0, polled: 0, seeded: 0 };

const keyOf = (mint: string) => `${CURVE_STREAM_KEY_PREFIX}${mint}`;

/** Starts the curve tape; returns its stop. `helius` reads the curves, `heliusStream` follows them (null: polls only). */
export function startCurveTape(
  helius: CurveReader,
  heliusStream: CurveStream | null,
  config: CurveTapeConfig,
) {
  reader = helius;
  stream = heliusStream;
  cfg = config;
  timer = setInterval(() => void round(), config.pollSeconds * 1_000);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const mint of followed.keys()) stream?.unwatch(keyOf(mint));
    followed.clear();
    reader = null;
    stream = null;
    cfg = null;
  };
}

/** An account update the Helius stream delivered under a curve key. */
export function onCurveStreamUpdate(key: string, data: string, bytes: number, now = Date.now()): void {
  const mint = key.slice(CURVE_STREAM_KEY_PREFIX.length);
  stats.updates += 1;
  stats.bytes += bytes;
  dayStreamCredits += streamCredits(bytes);
  const state = decodeCurve(data);
  if (!state) return;
  tape.record(mint, now, state, "stream");
  if (state.complete) drop(mint, true);
}

/**
 * The scan's watchlist this cycle, in its order: the young Pump.fun coins in it are followed (up
 * to CURVE_TAPE_MAX_MINTS), and the ones that left it or aged out are dropped.
 */
export function followYoungCurves(
  tracked: readonly {
    mintAddress: string;
    launchedAt: Date | null;
    firstSeenAt: Date;
    launchpad: string | null;
  }[],
  now = Date.now(),
): void {
  if (!cfg) return;
  const maxAgeMs = cfg.maxAgeMinutes * 60_000;
  const wanted = new Map<string, number>();
  for (const t of tracked) {
    if (wanted.size >= cfg.maxMints) break;
    if (t.launchpad === STONKS_LAUNCHPAD || done.has(t.mintAddress)) continue;
    if (now - (t.launchedAt ?? t.firstSeenAt).getTime() > maxAgeMs) continue;
    wanted.set(t.mintAddress, wanted.size);
  }
  for (const mint of followed.keys()) if (!wanted.has(mint)) drop(mint, false);
  for (const [mint, rank] of wanted) {
    let f = followed.get(mint);
    if (!f) {
      const curve = pumpCurveAddressOf(mint);
      if (!curve) continue;
      f = { curve, rank, readAt: null };
      followed.set(mint, f);
    }
    f.rank = rank;
    // Again every cycle: it keeps the subscription from being evicted as unwatched.
    if (!paused) stream?.watch(keyOf(mint), [f.curve], now, "account");
  }
}

/** The curve path features for a mint as of `now`: all null when its curve isn't followed. */
export function curvePathOf(mint: string, now = Date.now()): CurvePathFeatures {
  return followed.has(mint) ? tape.features(mint, now) : { ...EMPTY_CURVE_PATH };
}

/** Counts since the last call, for the scan's heartbeat; null while the tape is off. */
export function takeCurveTapeStats(now = Date.now()) {
  if (!cfg) return null;
  let streamed = 0;
  for (const [mint, f] of followed) if (stream?.coveredSince(keyOf(mint), f.curve) != null) streamed += 1;
  rollDay(now);
  const out = {
    following: followed.size,
    streamed,
    ...stats,
    streamCredits: streamCredits(stats.bytes),
    // getMultipleAccounts: 1 credit per call of up to 100 curves.
    readCredits: stats.readCalls,
    streamCreditsToday: Math.round(dayStreamCredits),
    paused: paused ? 1 : 0,
  };
  stats = { updates: 0, bytes: 0, readCalls: 0, curvesRead: 0, polled: 0, seeded: 0 };
  return out;
}

function drop(mint: string, forGood: boolean): void {
  if (followed.delete(mint)) stream?.unwatch(keyOf(mint));
  tape.forget(mint);
  if (forGood) {
    if (done.size >= MAX_DONE) done.clear();
    done.add(mint);
  }
}

function rollDay(now: number): void {
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    dayStreamCredits = 0;
  }
}

/**
 * Whether the stream's spend is past its share of the day so far: the day's cap times the share of
 * the UTC day gone, plus a tenth of the cap so a busy morning isn't cut at once.
 */
export function overStreamPace(creditsToday: number, capPerDay: number, now: number): boolean {
  const dayStart = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const share = (now - dayStart) / 86_400_000;
  return creditsToday > capPerDay * (share + 0.1);
}

/** One round: the pace check, then one batched read of the curves to seed and to poll. Visible for tests. */
export async function round(now = Date.now()): Promise<void> {
  if (!cfg || !reader || busy) return;
  busy = true;
  try {
    rollDay(now);
    const over = overStreamPace(dayStreamCredits, cfg.streamCreditsPerDay, now);
    if (over !== paused) {
      paused = over;
      logger.info(over ? "curve stream paused: past its credit pace" : "curve stream resumed", {
        streamCreditsToday: Math.round(dayStreamCredits),
      });
      for (const [mint, f] of followed) {
        if (over) stream?.unwatch(keyOf(mint));
        else stream?.watch(keyOf(mint), [f.curve], now, "account");
      }
    }
    const toRead: string[] = [];
    let polls = 0;
    let seeds = 0;
    for (const [mint, f] of followed) {
      const since = paused ? null : (stream?.coveredSince(keyOf(mint), f.curve) ?? null);
      if (since !== null) {
        // Streamed: read once after the subscription began, then the stream carries it.
        if (f.readAt === null || f.readAt < since) {
          toRead.push(mint);
          seeds += 1;
        } else tape.confirmStreamed(mint, since, now);
      } else if (f.rank < cfg.pollMaxMints) {
        toRead.push(mint);
        polls += 1;
      }
    }
    if (toRead.length === 0) return;
    const curves = toRead.map((mint) => followed.get(mint)!.curve);
    const states = await reader.getCurveStatesBatch(curves);
    stats.readCalls += Math.ceil(curves.length / 100);
    stats.curvesRead += curves.length;
    stats.polled += polls;
    stats.seeded += seeds;
    toRead.forEach((mint, i) => {
      const f = followed.get(mint);
      const state = states.get(curves[i]!);
      if (!f || state === undefined || state === "failed") return;
      if (state === null) {
        drop(mint, true);
        return;
      }
      // Stamped with when the read went out: a change the stream delivered while it was in
      // flight is newer, and the read doesn't overwrite it.
      tape.record(mint, now, state, "read");
      f.readAt = now;
      if (state.complete) drop(mint, true);
    });
  } catch (err) {
    logger.warn("curve read failed", { error: String(err) });
  } finally {
    busy = false;
  }
}

/** Visible for tests: forgets everything. */
export function resetCurveTape(): void {
  for (const mint of [...followed.keys()]) tape.forget(mint);
  followed.clear();
  done.clear();
  paused = false;
  day = "";
  dayStreamCredits = 0;
  stats = { updates: 0, bytes: 0, readCalls: 0, curvesRead: 0, polled: 0, seeded: 0 };
}
