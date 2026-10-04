import type { BoostingOptions } from "./boosting.js";
import { TRADE_FLOW_FEATURES, type CandidateFeatureName } from "./features.js";
import type { CuratorLearner } from "./trainer.js";

/**
 * The curator roster: every model that makes calls, each on its own ledger (CuratedAlert.model),
 * competing on the leaderboard (curation/leaderboard.ts). One list, so the id and display name a
 * subscriber picks in the model selector are the same ones the leaderboard ranks - nothing else
 * in the codebase names a contestant.
 *
 * Three roles:
 *  - "rules": the hand-tuned heuristic gate (curator.ts). Untrained; its hit-rate cutoff comes
 *    from the same walk-forward exam as everyone else's.
 *  - "learner": a trained model - a family (logistic or boosted trees) plus the recipe that makes
 *    it see the market differently from its rivals (recency, depth, feature subset). Diversity is
 *    the point: near-identical members teach the consensus nothing.
 *  - "stacked": the consensus - a second-order model trained on the other contestants' own
 *    out-of-sample calls (curation/stacking.ts). The default feed.
 *
 * Ids are stable storage keys (CuratedAlert.model, CuratorModel.contestant, User.curatedModel):
 * never rename one; retire it and add a new id instead.
 */

export type ContestantRole = "rules" | "learner" | "stacked";

/** What a learner contestant trains - the knobs that make it a different model. */
export interface CuratorRecipe {
  learner: CuratorLearner;
  /** Overrides CURATOR_RECENCY_HALF_LIFE_DAYS for this contestant. */
  recencyHalfLifeDays?: number;
  /** Logistic only: the features it reads (default: all). */
  featureNames?: readonly CandidateFeatureName[];
  /** Boosted only: hyperparameters over DEFAULT_BOOSTING_OPTIONS. */
  boosting?: BoostingOptions;
}

export interface ContestantSpec {
  id: string;
  /** What the leaderboard and the model selector both show. */
  name: string;
  /** One line on how it sees the market. */
  description: string;
  role: ContestantRole;
  recipe?: CuratorRecipe;
}

/** The consensus - what every subscriber sees until they pick another model. */
export const CONSENSUS_CONTESTANT = "consensus";
export const RULES_CONTESTANT = "rules";

/** "Recent" contestants forget fast: this meta rotates in days, and they bet on that. */
export const RECENT_HALF_LIFE_DAYS = 3;

/**
 * Order flow and short-window momentum only - what the last minutes of trading say, blind to
 * holder structure, socials and the heuristic's own scores. Deliberately partial: a member that
 * sees the market through one lens disagrees with the others in ways the consensus can use.
 */
export const ORDER_FLOW_FEATURES: readonly CandidateFeatureName[] = [
  "mcapUsd",
  "liquidityToMcapRatio",
  "priceChange5mPct",
  "priceChange1hPct",
  "volume5mUsd",
  "volume1hUsd",
  "volume5mToMcapRatio",
  "volume1hToMcapRatio",
  "volumeAccel",
  "buys1h",
  "sells1h",
  "buyRatio1h",
  "holderGrowth10mPct",
  "holderGrowthPct",
  "ageMinutes",
  "minutesSinceFirstInBand",
  // Who is doing the buying, trade by trade (curation/tradeFlow.ts).
  ...TRADE_FLOW_FEATURES,
];

export const CONTESTANTS: readonly ContestantSpec[] = [
  {
    id: CONSENSUS_CONTESTANT,
    name: "Consensus",
    description: "Learns how far to trust each other model, and calls when the room agrees",
    role: "stacked",
  },
  {
    id: RULES_CONTESTANT,
    name: "Rules",
    description: "The hand-tuned score and safety gates, at the cutoff its record earned",
    role: "rules",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Logistic regression on every feature, weighted toward the last two weeks",
    role: "learner",
    recipe: { learner: "logistic" },
  },
  {
    id: "linear-recent",
    name: "Linear Recent",
    description: "Logistic regression that mostly forgets anything older than a few days",
    role: "learner",
    recipe: { learner: "logistic", recencyHalfLifeDays: RECENT_HALF_LIFE_DAYS },
  },
  {
    id: "order-flow",
    name: "Order Flow",
    description: "Logistic regression on short-window volume, buys and momentum only",
    role: "learner",
    recipe: { learner: "logistic", featureNames: ORDER_FLOW_FEATURES },
  },
  {
    id: "trees",
    name: "Trees",
    description: "Gradient-boosted shallow trees that pick up thresholds and interactions",
    role: "learner",
    recipe: { learner: "gbdt" },
  },
  {
    id: "deep-trees",
    name: "Deep Trees",
    description: "Gradient-boosted deeper trees for three- and four-way interactions",
    role: "learner",
    recipe: { learner: "gbdt", boosting: { maxDepth: 5, minLeafRows: 50, maxTrees: 200 } },
  },
  {
    id: "trees-recent",
    name: "Trees Recent",
    description: "Gradient-boosted trees that mostly forget anything older than a few days",
    role: "learner",
    recipe: { learner: "gbdt", recencyHalfLifeDays: RECENT_HALF_LIFE_DAYS },
  },
];

export const CONTESTANT_IDS: readonly string[] = CONTESTANTS.map((c) => c.id);

export function contestantSpec(id: string): ContestantSpec | undefined {
  return CONTESTANTS.find((c) => c.id === id);
}

export function isContestantId(id: string): boolean {
  return CONTESTANT_IDS.includes(id);
}

/**
 * The enabled roster in canonical order, from CURATOR_CONTESTANTS. The consensus needs members,
 * so it is dropped when fewer than two learners are enabled; the rules contestant is always in
 * (it costs nothing to run and is the fallback default).
 */
export function enabledContestants(ids: readonly string[]): ContestantSpec[] {
  const wanted = new Set(ids);
  wanted.add(RULES_CONTESTANT);
  const learners = CONTESTANTS.filter((c) => c.role === "learner" && wanted.has(c.id));
  return CONTESTANTS.filter((c) => wanted.has(c.id) && (c.role !== "stacked" || learners.length >= 2));
}
