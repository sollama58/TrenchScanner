import { Prisma, prisma } from "../db.js";
import { LIVE_CONVICTION_MIN_SAMPLES } from "./convictionLine.js";
import { loadCurrentLanes } from "./laneStore.js";
import { LiveRescorer, type LiveSeatModel, type RescoreFeatures } from "./liveRescore.js";
import { CONTESTANTS } from "./contestants.js";
import { gatesById, loadModelGates } from "./modelGateStore.js";
import { LIVE_SCORE_WINDOW_HOURS, type LiveScales } from "./liveScale.js";
import { maskTokenSageXReuseLoss } from "./features.js";
import { buildRankRates, RANK_RATE_WINDOW_HOURS, type RankRateRow } from "./liveRankRates.js";
import { buildEntryProof } from "./entryProof.js";

/** Rows read per feature query: a retrain re-reads the whole window's feature vectors once. */
const FEATURE_BATCH = 500;

/** One per process: each model version scores each window moment once (curation/liveRescore.ts). */
let rescorer = new LiveRescorer();
/** Model params by CuratorModel id: a forest is read once, not every build. */
let paramsCache = new Map<string, unknown>();

/** Test hook: forget the cached model scores and params. */
export function resetLiveRescoreCache(): void {
  rescorer = new LiveRescorer();
  paramsCache = new Map();
}

/** The decision moments a live scale is read on: the cycle's (event rows) and the fast path's (entry rows). */
type ScalePopulation = "event" | "entry";

/**
 * The seats' live scales as of now (curation/liveScale.ts): the last LIVE_SCORE_WINDOW_HOURS of
 * decision moments, each scored by the model each seat calls on now (curation/liveRescore.ts),
 * each slot's counted from its current lane's handover. The worker decides on these and the API
 * explains its cutoffs with the same read. A model with no stored score on a moment scores it with
 * TokenSage's X-reuse and wave counts read as missing inside their lost window (`xReuseRestoredAt`
 * is TOKENSAGE_XREUSE_RESTORED_AT), as the live decision read them.
 *
 * Two populations come back from the one read: the cycle's decision moments (event rows) as the
 * scales themselves, and the fast path's (entry rows, since 2026-10-26) under `entry`, each seat's
 * scores there drawn from those rows alone. The rescorer's cache holds both sets of rows, so neither
 * read evicts the other's scores.
 */
export async function loadLiveScales(
  highConvictionRank: number,
  xReuseRestoredAt: Date | null,
  now = new Date(),
): Promise<LiveScales> {
  const windowStart = new Date(now.getTime() - LIVE_SCORE_WINDOW_HOURS * 3_600_000);
  const [allRows, lanes] = await Promise.all([
    prisma.candidateOutcome.findMany({
      where: {
        sampleKind: { in: ["event", "entry"] satisfies ScalePopulation[] },
        anchorAt: { gt: windowStart },
        seatScores: { not: Prisma.DbNull },
      },
      select: { id: true, anchorAt: true, seatScores: true, sampleKind: true },
    }),
    loadCurrentLanes(),
  ]);
  const rows = allRows.filter((r) => r.sampleKind === "event");
  const entryRows = allRows.filter((r) => r.sampleKind === "entry");
  const since = new Map(lanes.map((l) => [l.slot, l.bornAt]));
  // Only the seats that score live (every one of them stores its score on each moment).
  const seats = new Set<string>();
  for (const row of allRows) {
    const s = row.seatScores;
    if (s === null || typeof s !== "object" || Array.isArray(s)) continue;
    for (const k of Object.keys(s)) seats.add(k);
  }
  const models = await loadSeatModels(seats);
  const missing = rescorer.missingRows(allRows, models);
  // The gated seats' frozen filters (Gems), read only while one of them needs rows scored.
  const gated = new Set(CONTESTANTS.filter((c) => c.gate !== undefined).map((c) => c.id));
  const gates =
    missing.length > 0 && models.some((m) => gated.has(m.seat)) ? gatesById(await loadModelGates()) : {};
  for (let i = 0; i < missing.length; i += FEATURE_BATCH) {
    const batch = await prisma.candidateOutcome.findMany({
      where: { id: { in: missing.slice(i, i + FEATURE_BATCH) } },
      select: { id: true, anchorAt: true, features: true, anchorPriceUsd: true, anchorMcapUsd: true },
    });
    for (const row of batch) {
      rescorer.fill(
        row.id,
        {
          features: maskTokenSageXReuseLoss(
            row.anchorAt,
            (row.features ?? {}) as RescoreFeatures["features"],
            xReuseRestoredAt,
          ),
          anchorPriceUsd: row.anchorPriceUsd,
          anchorMcapUsd: row.anchorMcapUsd,
        },
        models,
        gates,
      );
    }
  }
  rescorer.prune(allRows, models);
  const scales = rescorer.build(rows, models, since, highConvictionRank, LIVE_CONVICTION_MIN_SAMPLES);
  const graded = await loadGradedRows(now, "event").catch(() => undefined);
  const out: LiveScales = graded ? { ...scales, rankRates: buildRankRates(graded) } : scales;
  if (entryRows.length === 0) return out;
  const entry = rescorer.build(entryRows, models, since, highConvictionRank, LIVE_CONVICTION_MIN_SAMPLES);
  // The same graded entry rows give the entry rank rates and the record a seat must clear to call
  // on the fast path at all (curation/entryProof.ts).
  const entryGraded = await loadGradedRows(now, "entry").catch(() => undefined);
  return {
    ...out,
    entry: entryGraded
      ? { ...entry, rankRates: buildRankRates(entryGraded), proof: buildEntryProof(entryGraded) }
      : entry,
  };
}

/**
 * The graded decision moments of the last RANK_RATE_WINDOW_HOURS with the scores stored on each,
 * which each seat's measured 2x rate by live rank band (curation/liveRankRates.ts) and, on entry
 * rows, its fast-path record (curation/entryProof.ts) are drawn from. A clean 2x is hit2xIn1h on a
 * row that wasn't disqualified, as the live records count it.
 */
async function loadGradedRows(now: Date, population: ScalePopulation): Promise<RankRateRow[]> {
  const rows = await prisma.candidateOutcome.findMany({
    where: {
      sampleKind: population,
      anchorAt: { gt: new Date(now.getTime() - RANK_RATE_WINDOW_HOURS * 3_600_000) },
      hit2xIn1h: { not: null },
      seatScores: { not: Prisma.DbNull },
    },
    select: { seatScores: true, hit2xIn1h: true, disqualified: true },
  });
  return rows.map((r) => ({
    seatScores: r.seatScores,
    won: r.hit2xIn1h === true && r.disqualified !== true,
  }));
}

/** Each seat's newest active model - the one the worker's roster scores it with. */
async function loadSeatModels(seats: ReadonlySet<string>): Promise<LiveSeatModel[]> {
  if (seats.size === 0) return [];
  const rows = await prisma.curatorModel.findMany({
    where: { status: "active", contestant: { in: [...seats] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, contestant: true, kind: true },
  });
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (row.contestant && !newest.has(row.contestant)) newest.set(row.contestant, row);
  const unread = [...newest.values()].filter((r) => !paramsCache.has(r.id)).map((r) => r.id);
  if (unread.length > 0) {
    const read = await prisma.curatorModel.findMany({
      where: { id: { in: unread } },
      select: { id: true, params: true },
    });
    for (const r of read) paramsCache.set(r.id, r.params);
  }
  const current = new Set([...newest.values()].map((r) => r.id));
  for (const id of paramsCache.keys()) if (!current.has(id)) paramsCache.delete(id);
  return [...newest.values()].flatMap((r) =>
    paramsCache.has(r.id)
      ? [{ seat: r.contestant!, id: r.id, kind: r.kind, params: paramsCache.get(r.id) }]
      : [],
  );
}
