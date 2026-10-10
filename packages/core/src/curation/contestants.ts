import type { BoostingOptions } from "./boosting.js";
import type { ForestOptions } from "./forest.js";
import {
  LEARNER_FEATURE_NAMES,
  learnerSubset,
  MARKET_CONTEXT_FEATURES,
  PRICE_PATH_FEATURES,
  SAFETY_FEATURES,
  TRADE_FLOW_FEATURES,
  type CandidateFeatureName,
} from "./features.js";
import { ALL_NARRATIVE_FEATURES } from "./narrativeFeatures.js";
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
 *  - "topslice": only the most confident calls of the tree seats - a token one of them ranks in
 *    the top quarter of its own calls - at a fixed cutoff, nothing fitted (curation/topSlice.ts).
 *  - "narrative": a trained model that decides only once TokenSage's deep read of the coin is
 *    stored (user decision 2026-10-07): on a decision moment that already carries it, and on a
 *    "second look" the scan takes when the deep read lands after the first decision
 *    (CandidateOutcome.sampleKind "second"). Graded only on the deep-read rows (trainingRun.ts,
 *    narrativeTrainingSet): the Narrative seat also trains on those alone, Narrative Blend on
 *    every row plus the second looks. Not a "learner": the combiners don't stack on it, it
 *    doesn't breed, and the other seats never train on its second-look rows. Lives behind
 *    TOKENSAGE_ENABLED. Two seats hold the role: Narrative (the narrative and the safety readings,
 *    no price, volume or age; user decision 2026-10-10) and Narrative Blend (the market and the
 *    narrative in two steps).
 *
 * Ids are stable storage keys (CuratedAlert.model, CuratorModel.contestant, User.curatedModel):
 * never rename one; retire it and add a new id instead.
 */

export type ContestantRole =
  "rules" | "learner" | "stacked" | "blend" | "agreement" | "topslice" | "narrative";

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
  /** Two-step narrative shape (see NarrativeBlendCuratorParams in trainer.ts): narrative seats only. */
  narrativeBlend?: boolean;
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
  /**
   * A fixed comparison seat (learners only): it trains, sits the exam and calls on its own ledger
   * like any learner, but no combiner stacks it, evolution neither breeds from nor replaces it,
   * and it never becomes the default model. It exists to be compared against, not followed.
   */
  control?: boolean;
}

/** The consensus - what every subscriber sees until they pick another model. */
export const CONSENSUS_CONTESTANT = "consensus";
export const RULES_CONTESTANT = "rules";
export const BLEND_CONTESTANT = "blend";
export const AGREEMENT_CONTESTANT = "agreement";
export const TOP_SLICE_CONTESTANT = "top-slice";
export const NARRATIVE_CONTESTANT = "narrative";
/** The two-step narrative seat - see the "narrative" role above and NarrativeBlendCuratorParams. */
export const NARRATIVE_BLEND_CONTESTANT = "narrative-blend";

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
]);

/**
 * The Narrative seat's inputs: every TokenSage input the learners read, plus the safety readings
 * (SAFETY_FEATURES) and no other market data. User decision 2026-10-10: the seat decides on the
 * narrative, with market data only as safety checks (Narrative Blend keeps its market stage).
 * Before, it also read age, volume acceleration, 10-minute holder growth and the 15-minute price
 * path, and shuffling those four moved 68% of its top-10% picks: most of its edge was the
 * market's. Walk-forward on 2,857 deep-read decision rows (2026-10-07 to 10-10): top-10% 2x rate
 * 16.5% with these inputs, 20.8% with the four market readings, 10.9% on TokenSage alone (base
 * 12.6%).
 * New TokenSage inputs join automatically: anything named ns* on the learner list.
 */
export const NARRATIVE_SEAT_FEATURES: readonly CandidateFeatureName[] = [
  ...SAFETY_FEATURES,
  ...LEARNER_FEATURE_NAMES.filter((name) => name.startsWith("ns")),
];

/**
 * The last half hour's price path and the market around it, plus the order flow - the "what is
 * it doing right now, and is now a good time" lens, blind to holder structure and socials.
 */
export const MOMENTUM_FEATURES: readonly CandidateFeatureName[] = learnerSubset([
  ...PRICE_PATH_FEATURES,
  ...MARKET_CONTEXT_FEATURES,
  ...ORDER_FLOW_FEATURES,
]);

/** Trees' twin that never reads TokenSage (see TREES_NO_TOKENSAGE_FEATURES). */
export const TREES_NO_TOKENSAGE_CONTESTANT = "trees-no-tokensage";

/**
 * Every learner input except TokenSage's. User decision 2026-10-09: keep one tree seat that never
 * reads TokenSage, so whether the read helps the market seats can be measured head to head. Since
 * #316 the onset guard holds the TokenSage inputs out of every market seat until enough rows carry
 * the read's new timing (about 10-12/13); after that Trees reads them again and this seat doesn't.
 */
export const TREES_NO_TOKENSAGE_FEATURES: readonly CandidateFeatureName[] = LEARNER_FEATURE_NAMES.filter(
  (name) => !name.startsWith("ns") && !(ALL_NARRATIVE_FEATURES as readonly string[]).includes(name),
);

/** A learner the combiners stack and evolution works on: every learner but the control seats. */
export function isMemberLearner(spec: ContestantSpec): boolean {
  return spec.role === "learner" && spec.control !== true;
}

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
    id: TOP_SLICE_CONTESTANT,
    name: "Top Slice",
    description:
      "Calls only what a tree model ranks in the top quarter of its own calls - fixed cutoff, nothing fitted",
    summary: "Waits for one of the tree models to be at its most sure, and sends only those calls.",
    role: "topslice",
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
    id: TREES_NO_TOKENSAGE_CONTESTANT,
    name: "Trees (no TokenSage)",
    description:
      "Trees' twin on every input except TokenSage's, kept to measure what the read adds - in no combiner, never the default",
    summary:
      "The same if-then rules as Trees, but it never sees TokenSage, so we can tell whether TokenSage helps.",
    role: "learner",
    recipe: { learner: "gbdt", featureNames: TREES_NO_TOKENSAGE_FEATURES },
    control: true,
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
      "Gradient-boosted trees trained on deep-read coins that decide only once TokenSage's deep read of the coin is in, reading every TokenSage input plus the safety readings (holder concentration, fresh, empty and sniper wallets, launch bundles, the dev's buy, RugCheck risk) and no price, volume or age",
    summary:
      "Waits for the deep read of what the coin is about (its theme, its X post, copycat signs), then decides from that, with the market used only as a safety check.",
    role: "narrative",
    recipe: { learner: "gbdt", featureNames: NARRATIVE_SEAT_FEATURES },
  },
  {
    // The Narrative seat's two-step sibling (user decision 2026-10-08): the market and the
    // narrative each get a stage, so it weighs both, where the Narrative seat is mostly the
    // narrative. Same rows and the same deep-read gate; it files its own calls like a learner
    // seat (the agrees/warns note on other cards stays the Narrative seat's).
    id: NARRATIVE_BLEND_CONTESTANT,
    name: "Narrative Blend",
    description:
      "Two steps: boosted trees score the coin from every market input, then shallow trees trained on deep-read coins weigh that score against TokenSage's read; decides only once the deep read is in",
    summary:
      "Takes the market's read of the coin and TokenSage's deep read of its story, and weighs the two together.",
    role: "narrative",
    recipe: { learner: "gbdt", narrativeBlend: true },
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
export const COMBINER_ROLES: readonly ContestantRole[] = ["stacked", "blend", "agreement", "topslice"];

/**
 * The enabled roster in canonical order, from CURATOR_CONTESTANTS. The combiners need members,
 * so they are dropped when fewer than two learners are enabled; the rules contestant is always
 * in (it costs nothing to run and is the fallback default).
 */
export function enabledContestants(ids: readonly string[]): ContestantSpec[] {
  const wanted = new Set(ids);
  wanted.add(RULES_CONTESTANT);
  const learners = CONTESTANTS.filter((c) => isMemberLearner(c) && wanted.has(c.id));
  return CONTESTANTS.filter(
    (c) => wanted.has(c.id) && (!COMBINER_ROLES.includes(c.role) || learners.length >= 2),
  );
}
