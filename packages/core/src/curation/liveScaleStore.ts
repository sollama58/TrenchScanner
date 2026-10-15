import { Prisma, prisma } from "../db.js";
import { LIVE_CONVICTION_MIN_SAMPLES } from "./convictionLine.js";
import { loadCurrentLanes } from "./laneStore.js";
import { buildLiveScales, LIVE_SCORE_WINDOW_HOURS, type LiveScales } from "./liveScale.js";

/**
 * The seats' live scales as of now (curation/liveScale.ts): the last LIVE_SCORE_WINDOW_HOURS of
 * decision moments' stored seat scores, each slot's counted from its current lane's handover. The
 * worker decides on these and the API explains its cutoffs with the same read.
 */
export async function loadLiveScales(highConvictionRank: number, now = new Date()): Promise<LiveScales> {
  const [rows, lanes] = await Promise.all([
    prisma.candidateOutcome.findMany({
      where: {
        sampleKind: "event",
        anchorAt: { gt: new Date(now.getTime() - LIVE_SCORE_WINDOW_HOURS * 3_600_000) },
        seatScores: { not: Prisma.DbNull },
      },
      select: { anchorAt: true, seatScores: true },
    }),
    loadCurrentLanes(),
  ]);
  const since = new Map(lanes.map((l) => [l.slot, l.bornAt]));
  return buildLiveScales(rows, since, highConvictionRank, LIVE_CONVICTION_MIN_SAMPLES);
}
