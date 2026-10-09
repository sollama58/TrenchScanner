import { prisma } from "../db.js";
import { CONSENSUS_CONTESTANT, RULES_CONTESTANT, type ContestantSpec } from "./contestants.js";
import type { Lane } from "./evolution.js";
import { liveCallRecords } from "./laneStore.js";
import { compositeScore, emptyRecord, rankByComposite, type CompositeScore } from "./leaderboard.js";
import type { PrecisionTargets } from "./trainer.js";
import { defaultContestant, NEVER_EMIT_THRESHOLD, type StoredEvalMetrics } from "./trainingRun.js";

/**
 * The default model: the leaderboard's best performer, re-chosen after every training run.
 *
 * Users who haven't picked a model by hand (User.followBestModel) see the champion's calls, and so
 * does everything else that means "the default" (the AI reviewer, the default-feed stats). The
 * pick is stored (CuratorChampion) so the worker and the API read the same answer and the
 * dashboard can say when it last changed.
 *
 * Two guards keep it from flapping on noise:
 *  - a model needs `minLiveGraded` graded live calls before it can hold the default, so a
 *    newcomer (or an evolved seat, which starts with a clean record) can't take it on a lucky
 *    streak or on its backtest alone;
 *  - a challenger has to beat the sitting champion by `margin` composite points to take over.
 * Until some model qualifies, the default stays on the old rule: the consensus once it can call,
 * else Rules (defaultContestant).
 */

/** The live window the champion is judged on - the leaderboard's default window. */
export const CHAMPION_WINDOW_DAYS = 30;

export interface ChampionRules {
  minLiveGraded: number;
  margin: number;
}

export interface ChampionStanding {
  id: string;
  name: string;
  /** Has a cutoff it can send at (the rules contestant always can). */
  calling: boolean;
  composite: CompositeScore;
}

export interface ChampionPick {
  id: string;
  /** False when nothing had enough live calls and the fallback rule chose. */
  qualified: boolean;
  reason: string;
}

export function pickChampion(
  standings: readonly ChampionStanding[],
  incumbent: string | null,
  rules: ChampionRules,
  fallback: string,
): ChampionPick {
  const nameOf = (id: string) => standings.find((s) => s.id === id)?.name ?? id;
  const eligible = standings.filter(
    (s) => s.calling && s.composite.score !== null && s.composite.live.graded >= rules.minLiveGraded,
  );
  if (eligible.length === 0) {
    return {
      id: fallback,
      qualified: false,
      reason: `No model has ${rules.minLiveGraded} graded live calls yet, so the default stays on ${nameOf(fallback)}.`,
    };
  }
  const top = rankByComposite(eligible)[0]!;
  const topScore = top.composite.score!;
  const held =
    incumbent !== null && incumbent !== top.id ? eligible.find((s) => s.id === incumbent) : undefined;
  // The margin only guards against noise between models judged alike. A seasoned leader outranks
  // a warming-up incumbent outright (the leaderboard ranks it first whatever the scores), or a
  // champion picked on a mostly-backtest score could never be unseated by the board's #1.
  const sameTier = held !== undefined && held.composite.warmingUp === top.composite.warmingUp;
  if (held && sameTier && topScore - held.composite.score! < rules.margin) {
    return {
      id: held.id,
      qualified: true,
      reason:
        `${held.name} keeps the default: ${top.name} leads by ${(topScore - held.composite.score!).toFixed(1)} ` +
        `points, under the ${rules.margin}-point margin a challenger needs.`,
    };
  }
  return {
    id: top.id,
    qualified: true,
    reason: `Best score on the leaderboard (${topScore.toFixed(1)}) among models with at least ${rules.minLiveGraded} graded live calls.`,
  };
}

/**
 * The default a reader should use: the stored champion while it can still send, else the
 * fallback rule. `canCall` is the reader's own view of the roster (the worker only counts a
 * consensus whose members are the generation it was stacked on), so a champion that has gone
 * silent or left the roster never leaves anyone with a feed that can't send.
 */
export function resolveDefaultModel(
  champion: string | null,
  canCall: (id: string) => boolean,
  fallback: string,
): string {
  return champion !== null && canCall(champion) ? champion : fallback;
}

export interface ChampionRecord {
  contestant: string;
  name: string;
  score: number | null;
  liveGraded: number;
  reason: string;
  chosenAt: Date;
}

const CHAMPION_SELECT = {
  contestant: true,
  name: true,
  score: true,
  liveGraded: true,
  reason: true,
  chosenAt: true,
} as const;

/** The current champion: the newest stored pick. Null before the first pick is stored. */
export async function loadChampion(): Promise<ChampionRecord | null> {
  return prisma.curatorChampion.findFirst({ orderBy: { chosenAt: "desc" }, select: CHAMPION_SELECT });
}

/** Each contestant's active model cutoff (params.threshold), read in SQL - see contestState. */
export async function activeModelCutoffs(
  contestants: readonly string[],
): Promise<Map<string, { threshold: number | null; metrics: Partial<StoredEvalMetrics> }>> {
  const out = new Map<string, { threshold: number | null; metrics: Partial<StoredEvalMetrics> }>();
  if (contestants.length === 0) return out;
  const rows = await prisma.$queryRaw<
    { contestant: string; threshold: number | null; evalMetrics: unknown }[]
  >`
    SELECT DISTINCT ON ("contestant") "contestant",
           CASE WHEN jsonb_typeof("params"->'threshold') = 'number'
                THEN ("params"->>'threshold')::float8 END AS threshold,
           "evalMetrics"
    FROM "CuratorModel"
    WHERE "status" = 'active' AND "contestant" = ANY(${[...contestants]})
    ORDER BY "contestant", "createdAt" DESC`;
  for (const r of rows) {
    out.set(r.contestant, {
      threshold: typeof r.threshold === "number" ? r.threshold : null,
      metrics:
        typeof r.evalMetrics === "object" && r.evalMetrics !== null
          ? (r.evalMetrics as Partial<StoredEvalMetrics>)
          : {},
    });
  }
  return out;
}

/**
 * Scores the roster the way the leaderboard does (30-day live record blended with the latest
 * exam), picks the champion, and stores it when it changed. Run after each training run.
 */
export async function rechooseChampion(input: {
  roster: readonly ContestantSpec[];
  lanes: readonly Lane[];
  targets: PrecisionTargets;
  rules: ChampionRules;
  now?: Date;
}): Promise<{ champion: ChampionRecord; changed: boolean; pick: ChampionPick }> {
  const now = input.now ?? new Date();
  const ids = input.roster.map((c) => c.id);
  const since = new Date(now.getTime() - CHAMPION_WINDOW_DAYS * 86_400_000);
  const [current, live, incumbent] = await Promise.all([
    activeModelCutoffs(ids),
    liveCallRecords(ids, since, input.lanes),
    loadChampion(),
  ]);
  const standings: ChampionStanding[] = input.roster.map((spec) => {
    const model = current.get(spec.id);
    return {
      id: spec.id,
      name: spec.name,
      // A control seat is there to be compared against, never to become the default.
      calling:
        spec.control !== true &&
        (spec.role === "rules" ||
          (model !== undefined && model.threshold !== null && model.threshold < NEVER_EMIT_THRESHOLD)),
      composite: compositeScore(
        live.get(spec.id) ?? emptyRecord(),
        model?.metrics.exam ?? emptyRecord(),
        input.targets,
      ),
    };
  });
  const consensusEnabled = ids.includes(CONSENSUS_CONTESTANT);
  const fallback = ids.includes(RULES_CONTESTANT)
    ? defaultContestant(consensusEnabled ? current.get(CONSENSUS_CONTESTANT)?.threshold : null)
    : (ids[0] ?? RULES_CONTESTANT);
  const pick = pickChampion(standings, incumbent?.contestant ?? null, input.rules, fallback);
  const chosen = standings.find((s) => s.id === pick.id);
  if (incumbent && incumbent.contestant === pick.id) {
    return { champion: incumbent, changed: false, pick };
  }
  const champion = await prisma.curatorChampion.create({
    data: {
      contestant: pick.id,
      name: chosen?.name ?? pick.id,
      score: chosen?.composite.score ?? null,
      liveGraded: chosen?.composite.live.graded ?? 0,
      previous: incumbent?.contestant ?? null,
      reason: pick.reason,
      chosenAt: now,
    },
    select: CHAMPION_SELECT,
  });
  return { champion, changed: true, pick };
}
