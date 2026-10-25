import { prisma } from "../db.js";
import { CONSENSUS_CONTESTANT, RULES_CONTESTANT, type ContestantSpec } from "./contestants.js";
import type { Lane } from "./evolution.js";
import { liveCallRecords, liveCatchRates } from "./laneStore.js";
import { emptyRecord, recordScore, withLiveCatch } from "./leaderboard.js";
import { TOP_MODELS_GRADE_LAG_MINUTES, TOP_MODELS_RANK_WINDOW_HOURS } from "./topModels.js";
import type { Env } from "../config/env.js";
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
 * It is ranked on the composite score of its live record over the last TOP_MODELS_RANK_WINDOW_HOURS
 * of graded calls (recordScore in leaderboard.ts: the 2x, 4x and 10x rates, the average return
 * under the exit plan, and its live catch), the same score the board, the Default models and the
 * "best" model are ranked on (user decision 2026-10-18: "make sure this new composite score is the
 * one used wherever we score models"). From 2026-10-17 it was the same scorecard without catch
 * (user decision: "train and judge on return AND 2x/4x/10x+ rate ... ALL of these are important").
 * From 2026-10-14 to then it was the 2x Wilson lower bound alone, as the Default trio still is
 * (topModels.ts, full audit P9).
 * It used to be the leaderboard's composite score, which pays 15 points for catching runners, so
 * Rules - calling about half of all moments on a tied points block - took it at 17:20 on 10-14
 * while ranking 15th of 19 on the lower bound (model audit 2026-10-14, rules-score R4; user
 * decision 2026-10-14: "champion ranked on the 2x lower bound like the Default").
 *
 * Two guards keep it from flapping on noise:
 *  - a model needs `minLiveGraded` graded live calls in the window before it can hold the
 *    default, so a newcomer (or an evolved seat, which starts with a clean record) can't take it
 *    on a lucky streak;
 *  - a challenger has to beat the sitting champion's lower bound by `margin` percentage points.
 * Until some model qualifies, the default stays on the old rule: the consensus once it can call,
 * else Rules (defaultContestant).
 */

/** The live window the champion is judged on - the Default trio's ranking window. */
export const CHAMPION_WINDOW_HOURS = TOP_MODELS_RANK_WINDOW_HOURS;

export interface ChampionRules {
  minLiveGraded: number;
  margin: number;
}

export interface ChampionStanding {
  id: string;
  name: string;
  /** Has a cutoff it can send at (the rules contestant always can). */
  calling: boolean;
  /** Graded live calls in the window, and the clean 2x among them. */
  graded: number;
  wins: number;
  /** The live record's full-scorecard score (recordScore); null with nothing graded. */
  score: number | null;
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
  const eligible = standings.filter((s) => s.calling && s.graded > 0 && s.graded >= rules.minLiveGraded);
  if (eligible.length === 0) {
    return {
      id: fallback,
      qualified: false,
      reason: `No model has ${rules.minLiveGraded} graded live alerts yet, so the default stays on ${nameOf(fallback)}.`,
    };
  }
  const pct = (s: ChampionStanding) => s.score ?? 0;
  const top = [...eligible].sort(
    (a, b) => pct(b) - pct(a) || b.graded - a.graded || a.id.localeCompare(b.id),
  )[0]!;
  const held =
    incumbent !== null && incumbent !== top.id ? eligible.find((s) => s.id === incumbent) : undefined;
  if (held && pct(top) - pct(held) < rules.margin) {
    return {
      id: held.id,
      qualified: true,
      reason:
        `${held.name} keeps the default: ${top.name}'s score leads by ${(pct(top) - pct(held)).toFixed(1)} ` +
        `points, under the ${rules.margin}-point margin a challenger needs.`,
    };
  }
  return {
    id: top.id,
    qualified: true,
    reason:
      `Best score on the full scorecard (${pct(top).toFixed(1)}, ${top.wins} of ${top.graded} doubled) over the last ` +
      `${CHAMPION_WINDOW_HOURS} hours among models with at least ${rules.minLiveGraded} graded live alerts.`,
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
/** The hit-rate targets the score is read against, from the env. */
export function curatedTargets(env: Env): PrecisionTargets {
  return {
    winRate: env.CURATED_TARGET_WIN_RATE_PCT / 100,
    goalRate: env.CURATED_TARGET_GOAL_RATE_PCT / 100,
    minSupport: env.CURATED_MIN_CALIBRATION_ALERTS,
    confidenceZ: env.CURATED_CALIBRATION_CONFIDENCE_Z,
  };
}

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
  rules: ChampionRules;
  targets: PrecisionTargets;
  now?: Date;
}): Promise<{ champion: ChampionRecord; changed: boolean; pick: ChampionPick }> {
  const now = input.now ?? new Date();
  const ids = input.roster.map((c) => c.id);
  // Ending the grade lag before now, so every call in the window has been graded.
  const until = new Date(now.getTime() - TOP_MODELS_GRADE_LAG_MINUTES * 60_000);
  const since = new Date(until.getTime() - CHAMPION_WINDOW_HOURS * 3_600_000);
  const [current, live, incumbent, catches] = await Promise.all([
    activeModelCutoffs(ids),
    liveCallRecords(ids, since, input.lanes, { until }),
    loadChampion(),
    // Runners up to now, not `until`: the catch read has no end bound, and the grade lag's few
    // minutes barely move a 72-hour share.
    liveCatchRates(ids, since, input.lanes),
  ]);
  const standings: ChampionStanding[] = input.roster.map((spec) => {
    const model = current.get(spec.id);
    return {
      id: spec.id,
      name: spec.name,
      // A control seat is there to be compared against, never to become the default; a
      // tracking-only seat files no calls.
      calling:
        spec.control !== true &&
        spec.trackingOnly !== true &&
        (spec.role === "rules" ||
          (model !== undefined && model.threshold !== null && model.threshold < NEVER_EMIT_THRESHOLD)),
      graded: (live.get(spec.id) ?? emptyRecord()).graded,
      wins: (live.get(spec.id) ?? emptyRecord()).wins,
      score: recordScore(
        withLiveCatch(live.get(spec.id) ?? emptyRecord(), catches.byModel.get(spec.id)),
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
      // The live score it was chosen on (the 2x lower bound in percent 2026-10-14..17, the
      // pooled composite before).
      score: chosen?.score ?? null,
      liveGraded: chosen?.graded ?? 0,
      previous: incumbent?.contestant ?? null,
      reason: pick.reason,
      chosenAt: now,
    },
    select: CHAMPION_SELECT,
  });
  return { champion, changed: true, pick };
}
