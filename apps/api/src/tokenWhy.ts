import {
  prisma,
  Prisma,
  liveCutoff,
  loadLiveScales,
  usableLiveScores,
  passesEventPreGate,
  NEVER_EMIT_THRESHOLD,
  rankFromQuantiles,
  inMcapBand,
  MAX_EVENT_AGE_MINUTES,
  MIN_BUY_RATIO,
  PRE_GATE_BUY_RATIO_MIN_AGE_MINUTES,
  PRE_GATE_OLD_COIN_MIN_AGE_MINUTES,
  PRE_GATE_OLD_COIN_MIN_5M_PCT,
  type Env,
  type LiveScales,
} from "@trenchscanner/core";
import { contestState } from "./contest.js";
import { asFeatures, isLearnerParams, loadParams, pushes } from "./modelExplain.js";
import { SharedCache } from "./sharedCache.js";
import { KeyedCache } from "./tokenChart.js";

/**
 * GET /tokens/:mint/why: why the models did or didn't call a coin (user ask 2026-10-16), for the
 * token modal's "Why it's here". Read off what the worker banked at the coin's decision moment
 * (CandidateOutcome, sampleKind "event"): each seat's score there (seatScores) against its cutoff
 * on today's live scale, and, for the seats that came closest, the inputs that pushed their score
 * up and down, recomputed from the stored inputs with the same code the worker scores with
 * (modelExplain.ts pushes). Labels and ranks only: no weights or raw scores leave here.
 *
 * A coin with no decision moment never met the models' pre-gate (passesEventPreGate): the answer
 * then names the test its newest scan missed.
 */

export interface WhySeat {
  id: string;
  name: string;
  /** Its score clears its cutoff on today's live scale. */
  calls: boolean;
  /** Where this coin's score sits among the seat's live scores: "top X%". Null without enough of them. */
  topPct: number | null;
  /** The share of its live scores its cutoff calls: "calls its top Y%". */
  callsTopPct: number | null;
  /** The inputs that pushed its score up and down most, strongest first; empty when not explained. */
  for: string[];
  against: string[];
}

export interface TokenWhy {
  /** The decision moment read, or null when the models never scored the coin. */
  moment: { at: string } | null;
  /** Why the models never scored it (the pre-gate test its newest scan missed); null when they did. */
  gate: string | null;
  /** The seats that scored it, the closest to calling (or calling) first. */
  seats: WhySeat[];
}

/** Seats whose pushes are recomputed: loading a forest's params is the costly part. */
const EXPLAINED_SEATS = 2;
/** Labels per side. */
const PUSH_LABELS = 3;
/** A call's moment is the newest event at or before it, give or take a scan's lag. */
const CALL_MOMENT_SLACK_MS = 2 * 60_000;

// The live scales read a day of seat scores: shared, refreshed every few minutes.
const liveCache = new SharedCache<LiveScales>(5 * 60_000, { name: "token-why-live-scales" });
// A moment's answer moves only with the live scale; kept per (mint, at) for a few minutes.
const whyCache = new KeyedCache<TokenWhy>(5 * 60_000, 200);
// One build at a time: each may load a couple of forests' params (megabytes each).
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** Share of `scores` (best first) strictly above `score`, as a "top X%" figure, 0.1 to 100. */
export function topPctOf(scores: readonly number[], score: number): number {
  let above = 0;
  for (const s of scores) {
    if (s > score) above++;
    else break;
  }
  return Math.min(100, Math.max(0.1, Math.round(((above + 1) / scores.length) * 1000) / 10));
}

/** The pre-gate test a scan misses, in plain words; null when it passes. */
export function gateMiss(
  s: {
    marketCapUsd: number;
    buys1h: number | null;
    sells1h: number | null;
    priceChange5mPct: number | null;
    ageMinutes: number | null;
  },
  band: { min: number; max: number },
): string | null {
  const scored = {
    marketCapUsd: s.marketCapUsd,
    buys1h: s.buys1h ?? undefined,
    sells1h: s.sells1h ?? undefined,
    priceChange5mPct: s.priceChange5mPct ?? undefined,
    ageMinutes: s.ageMinutes ?? undefined,
  };
  if (passesEventPreGate(scored, band)) return null;
  if (!inMcapBand(s.marketCapUsd, band)) return "its market cap was outside the band the models score";
  if (s.ageMinutes !== null && s.ageMinutes > MAX_EVENT_AGE_MINUTES) {
    return `it was over ${MAX_EVENT_AGE_MINUTES / 60} hours old, past the age the models score`;
  }
  const txns = (s.buys1h ?? 0) + (s.sells1h ?? 0);
  if (!(txns > 0)) return "it had no trades in the hour";
  if (
    !(s.ageMinutes !== null && s.ageMinutes < PRE_GATE_BUY_RATIO_MIN_AGE_MINUTES) &&
    (s.buys1h ?? 0) / txns < MIN_BUY_RATIO
  ) {
    return `buys were under ${Math.round(MIN_BUY_RATIO * 100)}% of the hour's trades`;
  }
  if (s.ageMinutes !== null && s.ageMinutes >= PRE_GATE_OLD_COIN_MIN_AGE_MINUTES) {
    return `past an hour old, it wasn't up ${PRE_GATE_OLD_COIN_MIN_5M_PCT}% over five minutes`;
  }
  return "its price was falling over the last five minutes";
}

/** Each served seat's cutoff parts, read out of params in SQL (params is the whole model). */
async function cutoffParts(ids: string[]) {
  if (ids.length === 0)
    return new Map<string, { threshold: number; cutoffRank?: number; quantiles?: number[] }>();
  const rows = await prisma.$queryRaw<
    { id: string; threshold: number | null; cutoffRank: number | null; quantiles: unknown }[]
  >`
    SELECT "id",
           CASE WHEN jsonb_typeof("params"->'threshold') = 'number'
                THEN ("params"->>'threshold')::float8 END AS threshold,
           CASE WHEN jsonb_typeof("params"->'cutoffRank') = 'number'
                THEN ("params"->>'cutoffRank')::float8 END AS "cutoffRank",
           "params"->'calibration'->'quantiles' AS quantiles
    FROM "CuratorModel"
    WHERE "id" = ANY(${ids})`;
  const out = new Map<string, { threshold: number; cutoffRank?: number; quantiles?: number[] }>();
  for (const r of rows) {
    if (typeof r.threshold !== "number") continue;
    out.set(r.id, {
      threshold: r.threshold,
      ...(typeof r.cutoffRank === "number" ? { cutoffRank: r.cutoffRank } : {}),
      ...(Array.isArray(r.quantiles) && r.quantiles.every((q) => typeof q === "number")
        ? { quantiles: r.quantiles as number[] }
        : {}),
    });
  }
  return out;
}

async function buildWhy(env: Env, tokenId: string, at: number | null): Promise<TokenWhy> {
  const moment = await prisma.candidateOutcome.findFirst({
    where: {
      tokenId,
      sampleKind: "event",
      seatScores: { not: Prisma.DbNull },
      ...(at !== null ? { anchorAt: { lte: new Date(at + CALL_MOMENT_SLACK_MS) } } : {}),
    },
    orderBy: { anchorAt: "desc" },
    select: { anchorAt: true, features: true, seatScores: true },
  });
  if (!moment) {
    const snap = await prisma.tokenSnapshot.findFirst({
      where: { tokenId, ...(at !== null ? { takenAt: { lte: new Date(at + CALL_MOMENT_SLACK_MS) } } : {}) },
      orderBy: { takenAt: "desc" },
      select: {
        marketCapUsd: true,
        buys1h: true,
        sells1h: true,
        priceChange5mPct: true,
        ageMinutes: true,
      },
    });
    const miss = snap ? gateMiss(snap, { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX }) : null;
    return { moment: null, gate: miss ?? "the models hadn't reached a decision moment on it yet", seats: [] };
  }

  const scores = (moment.seatScores ?? {}) as Record<string, unknown>;
  const [state, live] = await Promise.all([
    contestState(env),
    liveCache.get(() => loadLiveScales(env.CURATED_HIGH_CONVICTION_RANK)),
  ]);
  // The seats that call on a probability of their own: the learners and the narrative seats.
  const specs = state.roster.filter(
    (c) => (c.role === "learner" || c.role === "narrative") && c.retired !== true,
  );
  const models = new Map(
    specs
      .map((c) => [c.id, state.current.get(c.id)] as const)
      .filter(([, m]) => m !== undefined && m.threshold !== null && m.threshold < NEVER_EMIT_THRESHOLD),
  );
  const parts = await cutoffParts([...models.values()].map((m) => m!.id));

  const seats: (WhySeat & { margin: number; modelId: string })[] = [];
  for (const spec of specs) {
    const model = models.get(spec.id);
    const score = scores[spec.id];
    const part = model ? parts.get(model.id) : undefined;
    if (!model || !part || typeof score !== "number" || !Number.isFinite(score)) continue;
    const own = usableLiveScores(live.scores, spec.id);
    // As servedCutoffRank reads it: the run's own rank, else the shipped cutoff on its quantiles.
    const cutoffRank =
      part.cutoffRank ?? (part.quantiles ? rankFromQuantiles(part.quantiles, part.threshold) : undefined);
    const cutoff = liveCutoff(
      { threshold: part.threshold, ...(cutoffRank !== undefined ? { cutoffRank } : {}) },
      own,
    );
    seats.push({
      id: spec.id,
      name: spec.name,
      calls: score >= cutoff,
      topPct: own ? topPctOf(own, score) : null,
      callsTopPct: own ? topPctOf(own, cutoff) : null,
      for: [],
      against: [],
      margin: cutoff > 0 ? score / cutoff : 0,
      modelId: model.id,
    });
  }
  seats.sort((a, b) => b.margin - a.margin);

  const features = asFeatures(moment.features);
  if (features) {
    for (const seat of seats.slice(0, EXPLAINED_SEATS)) {
      const params = await loadParams(seat.modelId);
      if (!isLearnerParams(params)) continue;
      const pushed = pushes(params, features);
      seat.for = pushed.for.slice(0, PUSH_LABELS).map((p) => p.label);
      seat.against = pushed.against.slice(0, PUSH_LABELS).map((p) => p.label);
    }
  }

  return {
    moment: { at: moment.anchorAt.toISOString() },
    gate: null,
    seats: seats.map(({ margin: _margin, modelId: _modelId, ...s }) => s),
  };
}

/** Why the models did or didn't call `mintAddress`, at its decision moment at or before `at` (ms). */
export async function readTokenWhy(
  env: Env,
  mintAddress: string,
  at: number | null,
): Promise<TokenWhy | null> {
  const token = await prisma.token.findUnique({ where: { mintAddress }, select: { id: true } });
  if (!token) return null;
  // Bucketed to the minute so a card's repeat opens share an answer.
  const bucket = at === null ? "latest" : String(Math.floor(at / 60_000));
  return whyCache.get(`${mintAddress}:${bucket}`, () => serialized(() => buildWhy(env, token.id, at)));
}
