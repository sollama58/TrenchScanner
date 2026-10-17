import { Prisma, prisma } from "../db.js";
import { LIVE_CONVICTION_MIN_SAMPLES } from "./convictionLine.js";
import { loadCurrentLanes } from "./laneStore.js";
import { LiveRescorer, type LiveSeatModel, type RescoreFeatures } from "./liveRescore.js";
import { CONTESTANTS } from "./contestants.js";
import { gatesById, loadModelGates } from "./modelGateStore.js";
import { LIVE_SCORE_WINDOW_HOURS, type LiveScales } from "./liveScale.js";

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

/**
 * The seats' live scales as of now (curation/liveScale.ts): the last LIVE_SCORE_WINDOW_HOURS of
 * decision moments, each scored by the model each seat calls on now (curation/liveRescore.ts),
 * each slot's counted from its current lane's handover. The worker decides on these and the API
 * explains its cutoffs with the same read.
 */
export async function loadLiveScales(highConvictionRank: number, now = new Date()): Promise<LiveScales> {
  const [rows, lanes] = await Promise.all([
    prisma.candidateOutcome.findMany({
      where: {
        sampleKind: "event",
        anchorAt: { gt: new Date(now.getTime() - LIVE_SCORE_WINDOW_HOURS * 3_600_000) },
        seatScores: { not: Prisma.DbNull },
      },
      select: { id: true, anchorAt: true, seatScores: true },
    }),
    loadCurrentLanes(),
  ]);
  const since = new Map(lanes.map((l) => [l.slot, l.bornAt]));
  // Only the seats that score live (every one of them stores its score on each moment).
  const seats = new Set<string>();
  for (const row of rows) {
    const s = row.seatScores;
    if (s === null || typeof s !== "object" || Array.isArray(s)) continue;
    for (const k of Object.keys(s)) seats.add(k);
  }
  const models = await loadSeatModels(seats);
  const missing = rescorer.missingRows(rows, models);
  // The gated seats' frozen filters (Gems), read only while one of them needs rows scored.
  const gated = new Set(CONTESTANTS.filter((c) => c.gate !== undefined).map((c) => c.id));
  const gates =
    missing.length > 0 && models.some((m) => gated.has(m.seat)) ? gatesById(await loadModelGates()) : {};
  for (let i = 0; i < missing.length; i += FEATURE_BATCH) {
    const batch = await prisma.candidateOutcome.findMany({
      where: { id: { in: missing.slice(i, i + FEATURE_BATCH) } },
      select: { id: true, features: true, anchorPriceUsd: true, anchorMcapUsd: true },
    });
    for (const row of batch) {
      rescorer.fill(
        row.id,
        {
          features: (row.features ?? {}) as RescoreFeatures["features"],
          anchorPriceUsd: row.anchorPriceUsd,
          anchorMcapUsd: row.anchorMcapUsd,
        },
        models,
        gates,
      );
    }
  }
  rescorer.prune(rows, models);
  return rescorer.build(rows, models, since, highConvictionRank, LIVE_CONVICTION_MIN_SAMPLES);
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
