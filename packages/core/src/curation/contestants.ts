import type { BoostingOptions } from "./boosting.js";
import type { ForestOptions } from "./forest.js";
import {
  learnerSubset,
  MARKET_CONTEXT_FEATURES,
  PRICE_PATH_FEATURES,
  TRADE_FLOW_FEATURES,
  type CandidateFeatureName,
} from "./features.js";
import type { CuratorLearner } from "./trainer.js";

/**
 * The curator roster: every model that makes calls, each on its own ledger (CuratedAlert.model),
 * competing on the leaderboard (curation/leaderboard.ts). One list, so the id and display name a
 * subscriber picks in the model selector are the same ones the leaderboard ranks - nothing else
 * in the codebase names a contestant.
 *
 * Three roles:
 *  - "rules": a few readable checks. The hand-tuned heuristic gate (curator.ts) until a points
 *    table learned from the best model's picks (rulesDistill.ts) beats it on the exam; its
 *    hit-rate cutoff comes from the same walk-forward exam as everyone else's.
 *  - "learner": a trained model - a family (logistic, boosted trees under one of three objectives,
 *    or a random forest) plus the recipe that makes it see the market differently from its rivals
 *    (recency, depth, feature subset). Diversity is the point: near-identical members teach the
 *    consensus nothing.
 *  - "stacked": the consensus - a second-order model trained on the other contestants' own
 *    out-of-sample calls (curation/stacking.ts). The default feed.
 *  - "blend": the learners' confidence ranks averaged, nothing fitted (curation/blend.ts) - the
 *    consensus's unlearned rival.
 *  - "agreement": how many learners call the token at their own cutoff, nothing fitted
 *    (curation/agreement.ts) - the tokens the room agrees on, most agreed first.
 *  - "narrative": a trained model that decides only once TokenSage's deep read of the coin is
 *    stored (user decision 2026-10-07): on a decision moment that already carries it, and on a
 *    "second look" the scan takes when the deep read lands after the first decision
 *    (CandidateOutcome.sampleKind "second"). It trains on those rows alone, the ns* inputs beside
 *    the usual ones. Not a "learner": the combiners don't stack on it, it doesn't breed, and the
 *    other seats never train on its second-look rows. Lives behind TOKENSAGE_ENABLED.
 *
 * Ids are stable storage keys (CuratedAlert.model, CuratorModel.contestant, User.curatedModel):
 * never rename one; retire it and add a new id instead.
 */

export type ContestantRole = "rules" | "learner" | "stacked" | "blend" | "agreement" | "narrative";

/** What a learner contestant trains - the knobs that make it a different model. */
export interface CuratorRecipe {
  learner: CuratorLearner;
  /** Overrides CURATOR_RECENCY_HALF_LIFE_DAYS for this contestant. */
  recencyHalfLifeDays?: number;
  /** The features it reads (default: all). Training narrows it further to the run's usable inputs. */
  featureNames?: readonly CandidateFeatureName[];
  /** Boosted only: hyperparameters over DEFAULT_BOOSTING_OPTIONS, the objective among them. */
  boosting?: BoostingOptions;
  /** Forest only: hyperparameters over DEFAULT_FOREST_OPTIONS. */
  forest?: ForestOptions;
  /** Survival-first two-stage shape (see TwoStageCuratorParams in trainer.ts), either family. */
  twoStage?: boolean;
}

export interface ContestantSpec {
  id: string;
  /** What the leaderboard and the model selector both show. */
  name: string;
  /** One line on how it sees the market. */
  description: string;
  /**
   * The same in plain words, for the Models tab's front leaderboard (no jargon). A bred seat gets
   * one written from its recipe (evolution.ts plainSummary).
   */
  summary?: string;
  role: ContestantRole;
  recipe?: CuratorRecipe;
}

/** The consensus - what every subscriber sees until they pick another model. */
export const CONSENSUS_CONTESTANT = "consensus";
export const RULES_CONTESTANT = "rules";
export const BLEND_CONTESTANT = "blend";
export const AGREEMENT_CONTESTANT = "agreement";
export const NARRATIVE_CONTESTANT = "narrative";

/** "Recent" contestants forget fast: this meta rotates in days, and they bet on that. */
export const RECENT_HALF_LIFE_DAYS = 3;

/**
 * Order flow and short-window momentum only - what the last minutes of trading say, blind to
 * holder structure, socials and the heuristic's own scores. Deliberately partial: a member that
 * sees the market through one lens disagrees with the others in ways the consensus can use.
 */
export const ORDER_FLOW_FEATURES: readonly CandidateFeatureName[] = learnerSubset([
  "mcapUsd",
  "priceChange5mPct",
  "priceChange1hPct",
  "volume5mUsd",
  "volume1hUsd",
  "volume5mToMcapRatio",
  "volume1hToMcapRatio",
  "volumeAccel",
  "buys5m",
  "sells5m",
  "buyRatio5m",
  "buys1h",
  "sells1h",
  "holderGrowth10mPct",
  "ageMinutes",
  "minutesSinceFirstInBand",
  // Who is doing the buying, trade by trade (curation/tradeFlow.ts).
  ...TRADE_FLOW_FEATURES,
  "first15BuyersHolding",
]);

/**
 * The last half hour's price path and the market around it, plus the order flow - the "what is
 * it doing right now, and is now a good time" lens, blind to holder structure and socials.
 */
export const MOMENTUM_FEATURES: readonly CandidateFeatureName[] = learnerSubset([
  ...PRICE_PATH_FEATURES,
  ...MARKET_CONTEXT_FEATURES,
  ...ORDER_FLOW_FEATURES,
]);

export const CONTESTANTS: readonly ContestantSpec[] = [
  {
    id: CONSENSUS_CONTESTANT,
    name: "Consensus",
    description: "Learns how far to trust each other model, and calls when the room agrees",
    summary:
      "Doesn't read tokens itself: it learns which of the other models to trust and calls when they agree.",
    role: "stacked",
  },
  {
    id: BLEND_CONTESTANT,
    name: "Blend",
    description: "The trained models' confidence ranks averaged, with the extremes trimmed - nothing fitted",
    summary: "Averages how confident the other models are, with no learning of its own.",
    role: "blend",
  },
  {
    id: AGREEMENT_CONTESTANT,
    name: "Agreement",
    description:
      "Calls the tokens the most trained models call at their own cutoffs, most agreed first - nothing fitted",
    summary:
      "Counts how many of the other models would call a token, and calls the ones most of them agree on.",
    role: "agreement",
  },
  {
    id: RULES_CONTESTANT,
    name: "Rules",
    description:
      "A short points table copied from the best model's picks each training run (kept only when it tests better), else the hand-tuned gates",
    summary:
      "A few simple checks, refreshed from the best model's picks whenever they test better. It's also the fallback.",
    role: "rules",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Logistic regression on every feature, weighted toward the last two weeks",
    summary: "Weighs every signal on a token in one simple formula, leaning on the last two weeks.",
    role: "learner",
    recipe: { learner: "logistic" },
  },
  {
    id: "linear-recent",
    name: "Linear Recent",
    description: "Logistic regression that mostly forgets anything older than a few days",
    summary: "The same simple formula, but it mostly remembers only the last few days.",
    role: "learner",
    recipe: { learner: "logistic", recencyHalfLifeDays: RECENT_HALF_LIFE_DAYS },
  },
  {
    id: "order-flow",
    name: "Order Flow",
    description: "Logistic regression on short-window volume, buys and momentum only",
    summary: "Looks only at the last few minutes of trading: volume, buys against sells, and price moves.",
    role: "learner",
    recipe: { learner: "logistic", featureNames: ORDER_FLOW_FEATURES },
  },
  {
    id: "trees",
    name: "Trees",
    description: "Gradient-boosted shallow trees that pick up thresholds and interactions",
    summary: 'Learns if-then rules from every signal, like "lots of buyers and few fresh wallets".',
    role: "learner",
    recipe: { learner: "gbdt" },
  },
  {
    id: "deep-trees",
    name: "Deep Trees",
    description: "Gradient-boosted deeper trees for three- and four-way interactions",
    summary: "Like Trees, but with longer if-then chains to catch rarer combinations.",
    role: "learner",
    recipe: { learner: "gbdt", boosting: { maxDepth: 5, minLeafRows: 50, maxTrees: 200 } },
  },
  {
    id: "trees-recent",
    name: "Trees Recent",
    description: "Gradient-boosted trees that mostly forget anything older than a few days",
    summary: "If-then rules learned mostly from the last few days.",
    role: "learner",
    recipe: { learner: "gbdt", recencyHalfLifeDays: RECENT_HALF_LIFE_DAYS },
  },
  {
    id: "momentum",
    name: "Momentum",
    description:
      "Logistic regression on the last half hour's price path, order flow and the market around it",
    summary: "Reads the last half hour's price path and trading, plus the mood of the market around it.",
    role: "learner",
    recipe: { learner: "logistic", featureNames: MOMENTUM_FEATURES },
  },
  {
    id: "survivor",
    name: "Survivor",
    description: "Two boosted-tree stages: first whether it holds above the stop, then whether it doubles",
    summary: "Asks first whether a token will avoid a 50% drop, then whether it will double.",
    role: "learner",
    recipe: { learner: "gbdt", twoStage: true },
  },
  {
    id: "forest",
    name: "Forest",
    description:
      "A random forest: sixty deep trees, each grown on its own slice of rows and a third of the features, their votes averaged",
    summary: "Sixty independent if-then trees, each shown a different slice of the data, voting together.",
    role: "learner",
    recipe: { learner: "forest" },
  },
  {
    id: "ranker",
    name: "Ranker",
    description:
      "Boosted trees trained to order each hour's tokens by how far they ran (miss, 2x, 4x, 10x), not to predict a probability",
    summary:
      "Learns to put each hour's biggest runners at the top of the list, rather than to guess the odds of a double.",
    role: "learner",
    recipe: { learner: "gbdt", boosting: { objective: "lambdarank" } },
  },
  {
    id: "runner",
    name: "Runner",
    description:
      "Boosted trees that predict how far a token runs - its peak in doublings, stop-outs counting against - not whether it doubles",
    summary: "Predicts how big the run will be, so a likely 5x ranks above a sure 2x.",
    role: "learner",
    recipe: { learner: "gbdt", boosting: { objective: "runSize" } },
  },
  {
    id: NARRATIVE_CONTESTANT,
    name: "Narrative",
    description:
      "Gradient-boosted trees that decide only once TokenSage's deep read of the coin is in, reading it beside every usual input",
    summary:
      "Waits for the deep read of what the coin is about (its theme, its X post, copycat signs), then decides from that plus the usual signals.",
    role: "narrative",
    recipe: { learner: "gbdt" },
  },
];

export const CONTESTANT_IDS: readonly string[] = CONTESTANTS.map((c) => c.id);

export function contestantSpec(id: string): ContestantSpec | undefined {
  return CONTESTANTS.find((c) => c.id === id);
}

export function isContestantId(id: string): boolean {
  return CONTESTANT_IDS.includes(id);
}

/** Roles that combine the learners' calls rather than read tokens themselves. */
export const COMBINER_ROLES: readonly ContestantRole[] = ["stacked", "blend", "agreement"];

/**
 * The enabled roster in canonical order, from CURATOR_CONTESTANTS. The combiners need members,
 * so they are dropped when fewer than two learners are enabled; the rules contestant is always
 * in (it costs nothing to run and is the fallback default).
 */
export function enabledContestants(ids: readonly string[]): ContestantSpec[] {
  const wanted = new Set(ids);
  wanted.add(RULES_CONTESTANT);
  const learners = CONTESTANTS.filter((c) => c.role === "learner" && wanted.has(c.id));
  return CONTESTANTS.filter(
    (c) => wanted.has(c.id) && (!COMBINER_ROLES.includes(c.role) || learners.length >= 2),
  );
}
