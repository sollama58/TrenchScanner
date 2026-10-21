import type { BoostingOptions } from "./boosting.js";
import type { ForestOptions } from "./forest.js";
import {
  LEARNER_FEATURE_NAMES,
  learnerSubset,
  MARKET_CONTEXT_FEATURES,
  PRICE_PATH_FEATURES,
  SAFETY_FEATURES,
  TRADE_FLOW_FEATURES,
  WINNER_FOLLOW_FEATURES,
  type CandidateFeatureName,
} from "./features.js";
import { ALL_NARRATIVE_FEATURES } from "./narrativeFeatures.js";
import { NARRATIVE_STORY_WEIGHT } from "./narrativeLed.js";
import { GEMERALD_GATE } from "./modelGate.js";
import type { CuratorLearner, SeatGoal } from "./trainer.js";

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
 *    out-of-sample calls (curation/stacking.ts). The default feed. Since 2026-10-14 (user
 *    decision) it calls only moments at least CONSENSUS_MIN_BACKERS of its members call too.
 *    Trader (user decision 2026-10-16) holds the role too: the stacked model built for the
 *    trading bot, over every learner seat, no Rules inputs, no backing gate, its top ~10% only.
 *  - "blend": the learners' confidence ranks averaged, nothing fitted (curation/blend.ts) - the
 *    consensus's unlearned rival.
 *  - "agreement": how many learners call the token at their own cutoff, nothing fitted
 *    (curation/agreement.ts) - the tokens the room agrees on, most agreed first.
 *    Two learner seats are "standalone" (Sharp Trees, Sharp Survivor): a tree recipe whose
 *    cutoff passes only its top 8% or so of decision moments, outside the combiners and
 *    evolution (see ContestantSpec.standalone). Sharp Survivor took over from Sharp Deep Trees
 *    (retired, user decision 2026-10-14).
 *    Gems (user ask 2026-10-17) is a standalone seat too, with a gate: it considers only tokens
 *    that pass the Gemerald filter as it stood that day (ContestantSpec.gate, modelGate.ts), and
 *    trains and sits its exam on those moments alone. Winners (user ask 2026-10-17) is standalone
 *    on a reading of its own: it decides only on moments whose newest buyers were read through the
 *    clean winner wallets' records (ContestantSpec.requires, WINNERS_RECIPE).
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
 *    no price, volume or age, user decision 2026-10-10; since 2026-10-13 a story model and a
 *    safety model blended at a fixed weight, 30/70 since 2026-10-14, narrativeLed.ts) and
 *    Narrative Blend (the market and the narrative in two steps).
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
  /**
   * Story-led narrative shape (see NarrativeLedCuratorParams in narrativeLed.ts), gbdt only: the
   * story stage gets this fixed share of the decision and the safety readings the rest.
   */
  narrativeLed?: number;
  /**
   * The seat's own cutoff anchor, as a share of decision moments (PrecisionTargets.targetShare,
   * moved within HIGH_PRECISION_SHARE_BAND by hit rate): its exam and its cutoff use it in place
   * of the field's. Unset = the field's rule, which leans toward catching more runners.
   */
  cutoffShare?: number;
  /** What the seat is trained and examined on (SeatGoal in trainer.ts). Unset = "2x". */
  goal?: SeatGoal;
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
  /**
   * A seat with its own cutoff rule (learners only, CuratorRecipe.cutoffShare): it trains, sits
   * the exam, calls and can become the default like any learner, but no combiner stacks it and
   * evolution neither breeds from nor replaces it. A recipe close to another seat's would count
   * twice in the combiners, and a bred recipe taking the seat would drop the rule it is there for.
   */
  standalone?: boolean;
  /**
   * A retired seat: it no longer trains, calls, joins a combiner, breeds or shows on the roster,
   * and its past calls stay in the database but out of live stats (RETIRED_CONTESTANT_IDS). The
   * spec stays so its id is never reused and old rows still have a name.
   */
  retired?: boolean;
  /**
   * A gated seat (learners only, standalone): the ModelGate id of the frozen filter a token must
   * pass before the seat considers it (curation/modelGate.ts). It trains and sits its exam on the
   * moments that pass and decides live only on those, so its rows don't line up with the shared
   * exam's and no combiner, Trader included, stacks it. Without its gate stored it calls nothing.
   */
  gate?: string;
  /**
   * A seat on a reading of its own (learners only, standalone): the input a moment must carry
   * before the seat considers it (modelGate.ts seatConsiders), as the narrative seats need the deep
   * read. The Winners seat requires the clean-winner reading of the newest buyers. Like a gated
   * seat it trains and sits its exam on those moments alone, so no combiner, Trader included,
   * stacks it.
   */
  requires?: CandidateFeatureName;
}

/** A seat deciding on a population of its own: a frozen filter (gate) or a reading it needs (requires). */
export function hasOwnPopulation(spec: ContestantSpec): boolean {
  return spec.gate !== undefined || spec.requires !== undefined;
}

/** The consensus - what every subscriber sees until they pick another model. */
export const CONSENSUS_CONTESTANT = "consensus";
/** The stacked model a trading bot follows - see TRADER_CUTOFF_SHARE and stacking.ts. */
export const TRADER_CONTESTANT = "trader";
export const RULES_CONTESTANT = "rules";
export const BLEND_CONTESTANT = "blend";
export const AGREEMENT_CONTESTANT = "agreement";
export const TOP_SLICE_CONTESTANT = "top-slice";
export const NARRATIVE_CONTESTANT = "narrative";
/** The two-step narrative seat - see the "narrative" role above and NarrativeBlendCuratorParams. */
export const NARRATIVE_BLEND_CONTESTANT = "narrative-blend";

/** The high-precision seats - see HIGH_PRECISION_CUTOFF_SHARE. */
export const SHARP_TREES_CONTESTANT = "sharp-trees";
/** Survivor's two-stage recipe at the high-precision cutoff (user decision 2026-10-14). */
export const SHARP_SURVIVOR_CONTESTANT = "sharp-survivor";
/**
 * Retired 2026-10-14 (user decision): Deep Trees' exact recipe, seed and rows at a tighter cutoff,
 * so its exam matched Deep Trees' bit for bit and 99% of its live calls were Deep Trees' calls
 * (notes/model-audit-2026-10-14/objectives-sharp.md, section 4). Its seat went to Sharp Survivor
 * under a new id: a different model on the old id would have inherited Deep Trees' record.
 */
export const SHARP_DEEP_TREES_CONTESTANT = "sharp-deep-trees";

/** The goal seats (user ask 2026-10-17) - see SeatGoal in trainer.ts. */
export const SAFE_CONTESTANT = "safe";
export const FOUR_X_CONTESTANT = "four-x";
export const TEN_X_CONTESTANT = "ten-x";
export const CATCHER_CONTESTANT = "catcher";
/** Boosted trees fitted to the return itself (the "return" objective) - user decision 2026-10-17. */
export const RETURN_REGRESSION_CONTESTANT = "return-regression";
/** Boosted trees on made-money-or-not, each call weighted by what it made (the "payoff" objective). */
export const PROFIT_FACTOR_CONTESTANT = "profit-factor";
/** Catcher's cutoff anchor: a wider slice than the field's 20%, for the runners outside it. */
export const CATCHER_CUTOFF_SHARE = 0.35;

/** The gated seat on the Gemerald filter - see GEMS_RECIPE. */
export const GEMS_CONTESTANT = "gems";

/** The seat on the clean winners buying - see WINNERS_RECIPE. */
export const WINNERS_CONTESTANT = "winners";

/** "Recent" contestants forget fast: this meta rotates in days, and they bet on that. */
export const RECENT_HALF_LIFE_DAYS = 3;

/**
 * Trees Recent's own half-life, shorter than RECENT_HALF_LIFE_DAYS (which Linear Recent keeps).
 * A trial, user decision 2026-10-14: at 3 days the seat was not distinguishable from Trees (live
 * 20.9%, n=1,383; exam 21.5%). In the audit's walk-forward replica a 1-1.5 day half-life sharpened
 * the top 5% on the native fresh-quote rows by +4.8 [+0.2, +9.2] to +7.4 [+2.4, +12.2] points
 * (paired token-cluster bootstrap against 14 days), while over all days the gain was +2 to +3
 * points, inside noise (notes/model-audit-2026-10-14/trees-core.md). Judge it on its live record.
 */
export const TREES_RECENT_HALF_LIFE_DAYS = 1.5;

/**
 * Order flow and short-window momentum only - what the last minutes of trading say, blind to
 * holder structure, socials and the heuristic's own scores. Deliberately partial: a member that
 * sees the market through one lens disagrees with the others in ways the consensus can use.
 * Price and volume are the clock-honest readings (curation/clockFeatures.ts): the full named
 * window only when the pair has lived it, otherwise the move since the pair opened, per minute.
 * The mislabeled window sums are retired, so learnerSubset leaves them out.
 */
export const ORDER_FLOW_FEATURES: readonly CandidateFeatureName[] = learnerSubset([
  "mcapUsd",
  "px5mFullPct",
  "px1hFullPct",
  "pxSincePairPct",
  "pxSincePairPerMin",
  "volPerMin5m",
  "volume1hUsd",
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
 * The Narrative seat's inputs: every TokenSage input the learners read, whether the coin links an X
 * account and a website, plus the safety readings (SAFETY_FEATURES) and no other market data. The
 * seat's model (narrativeLed.ts) splits them: the safety readings feed its safety check, the rest
 * its story stage, which carries NARRATIVE_STORY_WEIGHT of the decision (user ask 2026-10-13; 30% since
 * 2026-10-14, see the constant). User decision 2026-10-10: the seat decides on the
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
  ...learnerSubset(["hasTwitter", "hasWebsite"]),
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

/**
 * A learner the combiners stack and evolution works on: every learner but the control and
 * standalone seats.
 */
export function isMemberLearner(spec: ContestantSpec): boolean {
  return (
    spec.role === "learner" && spec.control !== true && spec.standalone !== true && spec.retired !== true
  );
}

/**
 * The high-precision seats' cutoff (user ask 2026-10-12: "the highest % 2x/4x/10x possible,
 * while also trying to only alert about 6/hr ... can be more but generally shouldn't be less";
 * 2026-10-13: "find the highest returning runners, and call only those"; 2026-10-21: narrow it).
 * The top 8% of decision moments, moved within HIGH_PRECISION_SHARE_BAND by hit rate
 * (PrecisionTargets.targetShare).
 *
 * It was the top 12% from 2026-10-13 through 2026-10-21. At the 50-60 decision moments an hour
 * the feed saw on 10-12, 12% is 6-7 calls an hour and 8% is about 4-5, under that 6/hr floor.
 * The band can still sit the cutoff as high as 11% (about 6 an hour when the feed is busy).
 * Top 5% was measured and not taken: it catches about 8% of the runners.
 *
 * The 12% anchor replaced a pace floor of 8 calls per exam hour (PrecisionTargets.minCallsPerHour).
 * That floor was set when the exam saw about 42 moments an hour, so it meant the top fifth; once
 * the exam graded rule-4 rows only and grew to 70% of the history it saw about 33 an hour, the
 * floor meant the top quarter to third, and live the seats sent 21-24 calls an hour (10-13
 * 00:00-04:00, against Trees' 20), no sharper than the field. A share carries over from the exam
 * to the live feed; a count per exam hour does not.
 * Walk-forward replay, 12-hour blocks 10-09..10-13 (rule-4 grades, base 2x 15%), each block's
 * cutoff chosen on the three days before it (2x / 4x / runners caught). The 2026-10-21 step is
 * the top 8% row, not the top 5%:
 *  - Sharp Trees' recipe: floor 8/h passed 25% of moments, 20.9% / 7.6% / 41%; top 12% +-3:
 *    23.7% / 9.1% / 24%; top 8%: 25.4% / 10.6% / 16%; top 5%: 28.2% / 13.6% / 8%.
 *  - Sharp Deep Trees' recipe: floor 8/h passed 32% of moments, 21.7% / 8.3% / 55%; top 12% +-3:
 *    21.6% / 8.8% / 17%. Its ranking does not get sharper toward the top on this data.
 *
 * A model already serving keeps the cutoff it was trained with. This share is what the next
 * train writes into a new high-precision recipe.
 */
export const HIGH_PRECISION_CUTOFF_SHARE = 0.08;
/** How far, as a share of moments, the high-precision cutoff may move from its anchor. */
export const HIGH_PRECISION_SHARE_BAND = 0.03;

/**
 * Trader's cutoff anchor, as a share of decision moments (moved within HIGH_PRECISION_SHARE_BAND by
 * hit rate, as the Sharp seats' is). Walk-forward replay of the live calls, 10-11..10-16, one buy
 * per token (notes/combiner-eval-2026-10-16/report.md, section 2): a logistic stacker over every
 * seat's day-ranked confidence trading its top 9% averaged -5.5% a trade under the site's exit
 * plan (2x 21.1%, ~120 a day); its top 19% -6.4%, its top half -11.2%, Consensus -11.1%.
 */
export const TRADER_CUTOFF_SHARE = 0.1;

/**
 * Whether a learner seat feeds Trader: every learner that trains on the shared exam rows, the
 * control and standalone seats included (a stacker weighs each one, so a near-duplicate seat
 * costs it little, unlike a vote). The narrative seats sit a different exam population.
 */
export function isTraderMember(spec: ContestantSpec): boolean {
  return spec.role === "learner" && spec.retired !== true && !hasOwnPopulation(spec);
}

/**
 * Gems (user ask 2026-10-17: "based on the traits of our best-performing models"), traits picked by
 * live 2x hit rate over 3, 7 and 30 days (/stats/hit-rates, 2026-10-17; n = 220-2,450 graded calls
 * a seat). The leaders were close together, 21-22% against Gemerald's own 17.8%:
 *  - boosted trees: Trees 21.9% (30d), Simple Trees 21.8%, Trees Recent 22.3% (3d) - the tree seats
 *    led every window;
 *  - survival first: Survivor 21.6-21.7% and Sharp Survivor 21.2%, the only seat averaging a profit
 *    a trade under the site's exit plan (+4.3%, 7d);
 *  - no TokenSage read: Simple Trees, Trees' twin without it, matched or beat Trees in every window;
 *  - a short memory: Linear Recent (3-day half-life) 21.6-21.7%, Trees Recent (1.5 days) 22.3% (3d);
 *  - only its surest calls: Top Slice 21.6-21.8% and the Sharp seats' high-precision cutoff.
 * The spread between seats is inside noise at these counts; the gate is what makes Gems different.
 */
export const GEMS_RECIPE: CuratorRecipe = {
  learner: "gbdt",
  twoStage: true,
  featureNames: TREES_NO_TOKENSAGE_FEATURES,
  recencyHalfLifeDays: RECENT_HALF_LIFE_DAYS,
  cutoffShare: HIGH_PRECISION_CUTOFF_SHARE,
  goal: "return",
};

/**
 * The clean-winner inputs Winners reads: every WINNER_FOLLOW_FEATURES input but the two counts,
 * which run lower on the backfilled rows than live (a tape starts minutes before its anchor) and
 * did no better than the shares (wallets/winnerFollow.ts).
 */
export const WINNERS_SEAT_INPUTS: readonly CandidateFeatureName[] = WINNER_FOLLOW_FEATURES.filter(
  (name) => name !== "cleanWinnerRecentBuyers" && name !== "recentBuyersRead",
);

/**
 * Winners (user ask 2026-10-17: "a model that learns based on the top-performing winner wallets",
 * leaving out wallets whose wins came from tokens transferred in, and learning how those wallets
 * trade; notes/winners-model-2026-10-17): Gems' shape - Survivor's two boosted-tree stages on every
 * input but TokenSage's, a 3-day half-life, the Sharp seats' high-precision cutoff - plus the clean
 * winners' reading of the newest trades (WINNERS_SEAT_INPUTS, core's wallets/winnerFollow.ts):
 * their share of the buyers and the SOL, the buyers' own 2x record, and how the winners are trading
 * the coin (conviction, buying in against getting out, their share of the sellers). Every other
 * learner reads all eight clean-winner inputs (WINNER_FOLLOW_FEATURES), the two counts included,
 * and a missing tape stays null. Winners still skips those counts, which run lower on the
 * backfilled rows than live, so its list is the trees' inputs with the eight taken out and
 * WINNERS_SEAT_INPUTS put back. It decides only on moments that carry the reading
 * (ContestantSpec.requires), so its exam is the moments the live tape was read on, filled for the
 * history by the worker's winnerFollowBackfill.ts.
 *
 * Point-in-time on 9,837 rows decided around a taped coin (10-11..10-17), a boosted-tree fit with
 * the reading against the same fit without it: walk-forward AUC 0.631 against 0.597, a top-12% 2x
 * rate of 32.6% against 28.3% and a top-5% one of 38.5% against 33.9% (four time splits, three
 * seeds each; base rate 17.7%).
 */
export const WINNERS_RECIPE: CuratorRecipe = {
  learner: "gbdt",
  twoStage: true,
  featureNames: [
    ...TREES_NO_TOKENSAGE_FEATURES.filter(
      (name) => !(WINNER_FOLLOW_FEATURES as readonly string[]).includes(name),
    ),
    ...WINNERS_SEAT_INPUTS,
  ],
  recencyHalfLifeDays: RECENT_HALF_LIFE_DAYS,
  cutoffShare: HIGH_PRECISION_CUTOFF_SHARE,
  goal: "return",
};

export const CONTESTANTS: readonly ContestantSpec[] = [
  {
    id: CONSENSUS_CONTESTANT,
    name: "Consensus",
    description:
      "Learns how far to trust each other model, and alerts only when at least three of them alert on the token at their own cutoffs",
    summary:
      "Doesn't read tokens itself: it learns which of the other models to trust, and alerts only when at least three of them alert on it too.",
    role: "stacked",
  },
  {
    id: TRADER_CONTESTANT,
    name: "Trader",
    description:
      "Learns how far to trust every other trained model, Sharp seats included, and alerts only on its surest tenth of decision moments - built for the trading bot",
    summary:
      "Built for trading: learns which of the other models to trust and alerts only on the tokens it is surest of, about a tenth of what it sees.",
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
      "Alerts on the tokens the most trained models alert on at their own cutoffs, most agreed first - nothing fitted",
    summary:
      "Counts how many of the other models would alert on a token, and alerts on the ones most of them agree on.",
    role: "agreement",
  },
  {
    id: TOP_SLICE_CONTESTANT,
    name: "Top Slice",
    description:
      "Alerts only on what a tree model ranks in the top quarter of its own alerts - fixed cutoff, nothing fitted",
    summary: "Waits for one of the tree models to be at its most sure, and sends only those alerts.",
    role: "topslice",
  },
  {
    id: RULES_CONTESTANT,
    name: "Rules",
    description:
      "A short points table copied from the best model's alerts each training run (kept only when it tests better), else the hand-tuned gates",
    summary:
      "A few simple checks, refreshed from the best model's alerts whenever they test better. It's also the fallback.",
    role: "rules",
  },
  {
    id: "linear",
    name: "Formula",
    description:
      "Logistic regression on every feature, weighted toward the last two weeks, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary: "Weighs every signal on a token in one simple formula, leaning on the last two weeks.",
    role: "learner",
    recipe: { learner: "logistic", goal: "return" },
  },
  {
    id: "linear-recent",
    name: "Fresh Formula",
    description:
      "Logistic regression that mostly forgets anything older than a few days, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary: "The same simple formula, but it mostly remembers only the last few days.",
    role: "learner",
    recipe: { learner: "logistic", recencyHalfLifeDays: RECENT_HALF_LIFE_DAYS, goal: "return" },
  },
  {
    id: "order-flow",
    name: "Order Flow",
    description:
      "Logistic regression on short-window volume, buys and momentum only, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary: "Looks only at the last few minutes of trading: volume, buys against sells, and price moves.",
    role: "learner",
    recipe: { learner: "logistic", featureNames: ORDER_FLOW_FEATURES, goal: "return" },
  },
  {
    id: "trees",
    name: "Trees",
    description:
      "Gradient-boosted shallow trees that pick up thresholds and interactions, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary: 'Learns if-then rules from every signal, like "lots of buyers and few fresh wallets".',
    role: "learner",
    recipe: { learner: "gbdt", goal: "return" },
  },
  {
    id: TREES_NO_TOKENSAGE_CONTESTANT,
    name: "Simple Trees",
    description:
      "Trees' twin on every input except TokenSage's, kept to measure what the read adds - in no combiner, never the default, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary:
      "The same if-then rules as Trees, but it never sees TokenSage, so we can tell whether TokenSage helps.",
    role: "learner",
    recipe: { learner: "gbdt", featureNames: TREES_NO_TOKENSAGE_FEATURES, goal: "return" },
    control: true,
    // User decision 2026-10-18 (notes/model-audit-2026-10-18): it called the same 33 moments as
    // Trees after the goal-based exams (Jaccard 1.00), so TokenSage changes nothing for Trees and
    // the control has given its answer.
    retired: true,
  },
  {
    id: "deep-trees",
    name: "Deep Trees",
    description:
      "Gradient-boosted deeper trees for three- and four-way interactions, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary: "Like Trees, but with longer if-then chains to catch rarer combinations.",
    role: "learner",
    recipe: { learner: "gbdt", boosting: { maxDepth: 5, minLeafRows: 50, maxTrees: 200 }, goal: "return" },
  },
  {
    id: "trees-recent",
    name: "Fresh Trees",
    description:
      "Gradient-boosted trees where a row counts half after 1.5 days, so mostly the last day or two (a trial since 2026-10-14), ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary: "If-then rules learned mostly from the last day or two.",
    role: "learner",
    // 1.5-day half-life since 2026-10-14 (was 3), a trial (user decision 2026-10-14): see
    // TREES_RECENT_HALF_LIFE_DAYS. Same id and family - the seat keeps its record and its lane.
    recipe: { learner: "gbdt", recencyHalfLifeDays: TREES_RECENT_HALF_LIFE_DAYS, goal: "return" },
  },
  {
    id: "momentum",
    name: "Momentum",
    description:
      "Logistic regression on the last half hour's price path, order flow and the market around it, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary: "Reads the last half hour's price path and trading, plus the mood of the market around it.",
    role: "learner",
    recipe: { learner: "logistic", featureNames: MOMENTUM_FEATURES, goal: "return" },
  },
  {
    id: "survivor",
    name: "Survivor",
    description:
      "Two boosted-tree stages: first whether it holds above the stop, then whether it doubles, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary: "Asks first whether a token will avoid a 50% drop, then whether it will double.",
    role: "learner",
    recipe: { learner: "gbdt", twoStage: true, goal: "return" },
  },
  {
    id: "forest",
    name: "Forest",
    description:
      "A random forest: sixty deep trees, each grown on its own slice of rows and a third of the features, their votes averaged, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary: "Sixty independent if-then trees, each shown a different slice of the data, voting together.",
    role: "learner",
    recipe: { learner: "forest", goal: "return" },
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
    // User decision 2026-10-11: it called the most of any seat at about the market's rate and
    // flooded on tied scores (144 calls in one 6h replay block, 77 on a single score), pulling
    // down the pooled averages.
    retired: true,
  },
  {
    id: "runner",
    name: "Moonshot",
    description:
      "Boosted trees that predict how far a token runs - its peak in doublings, any loss counting 0 - with every winner weighted hard by how far it ran; judged on run size",
    summary: "Hunts the biggest runs: a likely 10x ranks far above a sure 2x.",
    role: "learner",
    // Was "Runner" (run size alone) until 2026-10-17 (user ask: "one whose goal is ultimately
    // massive runners"): same id and objective, now with the moonshot goal's run weight.
    recipe: { learner: "gbdt", boosting: { objective: "runSize" }, goal: "moonshot" },
  },
  {
    id: SHARP_TREES_CONTESTANT,
    name: "Sharp",
    description:
      "Slow, coarse boosted trees (depth 4, 100 rows a leaf) alerting only on their surest tokens: about the top 8% of decision moments, moved by 2x record",
    summary:
      "Alerts only on the tokens it is surest of, about 4-5 an hour, for the best hit rate rather than catching every runner.",
    role: "learner",
    recipe: {
      learner: "gbdt",
      boosting: { maxDepth: 4, minLeafRows: 100, learningRate: 0.03, maxTrees: 400 },
      cutoffShare: HIGH_PRECISION_CUTOFF_SHARE,
      goal: "2x",
    },
    standalone: true,
  },
  {
    id: SHARP_DEEP_TREES_CONTESTANT,
    name: "Sharp Deep Trees",
    description:
      "Deep Trees' boosted trees, trained on a clean 2x, alerting only on their surest tokens: about the top 8% of decision moments, moved by 2x record",
    summary:
      "Alerts only on the tokens Deep Trees' trees are surest of, about 4-5 an hour, for the best hit rate rather than catching every runner.",
    role: "learner",
    recipe: {
      learner: "gbdt",
      boosting: { maxDepth: 5, minLeafRows: 50, maxTrees: 200 },
      cutoffShare: HIGH_PRECISION_CUTOFF_SHARE,
      goal: "2x",
    },
    standalone: true,
    // User decision 2026-10-14: a bit-identical copy of Deep Trees; see SHARP_DEEP_TREES_CONTESTANT.
    retired: true,
  },
  {
    // Took Sharp Deep Trees' place (user decision 2026-10-14): the field's only tight,
    // survival-first view. In the audit's walk-forward replica Survivor's ranking was the most
    // distinct in the tree family (Jaccard 0.01-0.12 with Trees at the top 1-5%) with the most
    // consistent small top-end edge (seed-averaged top 3% 24.3% vs 18.7%, top 5% 23.0% vs 19.9%,
    // inside noise) and 16 points fewer stop-outs in its top 5%
    // (notes/model-audit-2026-10-14/objectives-sharp.md, 4.6).
    id: SHARP_SURVIVOR_CONTESTANT,
    name: "Sharp Survivor",
    description:
      "Survivor's two boosted-tree stages (first whether it holds above the stop, then whether it doubles), trained on a clean 2x, alerting only on their surest tokens: about the top 8% of decision moments, moved by 2x record",
    summary:
      "Asks first whether a token will avoid a 50% drop, then whether it will double, and alerts only on the ones it is surest of, about 4-5 an hour.",
    role: "learner",
    recipe: { learner: "gbdt", twoStage: true, cutoffShare: HIGH_PRECISION_CUTOFF_SHARE, goal: "2x" },
    standalone: true,
  },
  {
    id: SAFE_CONTESTANT,
    name: "Safe",
    description:
      "Boosted trees ranked on expected return under the exit plan with every loss counted twice: a 2x model beside a model of falling to the stop before the first sale; judged on that loss-averse return",
    summary: "Steers clear of coins likely to crash 50%, and alerts on the ones that can still pay.",
    role: "learner",
    recipe: { learner: "gbdt", goal: "safe" },
    standalone: true,
  },
  {
    id: FOUR_X_CONTESTANT,
    name: "4x Hunter",
    description:
      "Boosted trees trained on a clean 4x inside 30 minutes (anything less is a miss); judged on its 4x rate",
    summary: "Looks only for coins that can quadruple, not just double.",
    role: "learner",
    recipe: { learner: "gbdt", goal: "4x" },
    standalone: true,
  },
  {
    id: TEN_X_CONTESTANT,
    name: "10x Hunter",
    description:
      "Boosted trees trained on a clean 10x inside the hour; a run with fewer than 30 rows whose 10x verdict is known skips the seat instead of training a 4x model under this name; judged on its 10x rate",
    summary: "Looks only for coins that can go ten times.",
    role: "learner",
    recipe: { learner: "gbdt", goal: "10x" },
    standalone: true,
  },
  {
    id: CATCHER_CONTESTANT,
    name: "Catcher",
    description:
      "Boosted trees on a clean 2x leaning toward the runners, alerting on a wider slice (about the top 35% of decision moments); judged on how many runners it catches",
    summary: "Casts the widest net: catches as many of the runners as it can while its hit rate holds.",
    role: "learner",
    recipe: { learner: "gbdt", goal: "catch", cutoffShare: CATCHER_CUTOFF_SHARE },
    standalone: true,
  },
  {
    // User decision 2026-10-17 ("do what is best for ultimately making the most money", cap at
    // +500%): on the rule-4 rows 10-07..10-17 replayed under EXIT_PLAN, the top 20% a day by a
    // return regression doubled 21.5%, stopped out 52.7% and returned +3.4% a call, against
    // 16.2% / 43.1% / +1.1% for the expected-return formula and 23.8% / 65.3% / -1.0% for P(2x),
    // inside noise (notes/return-formula-2026-10-17). It sits beside them so the exam decides.
    // At the Sharp seats' tighter cutoff: on the same replay every ranking returned far more a
    // call on its top 10% than its top 20% (the return regression +6.7% vs +2.6%, P(2x) +9.0% vs
    // -0.5%), and made more in total too.
    id: RETURN_REGRESSION_CONTESTANT,
    name: "Profit",
    description:
      "Boosted trees fitted straight to each alert's return under the exit plan (capped at +500%), with no split into 2x and crash odds, alerting only on the coins it expects to pay most: about the top 8% of decision moments; judged on return",
    summary:
      "Learns how much an alert makes under the exit plan, and alerts only on the coins it expects to pay most.",
    role: "learner",
    recipe: {
      learner: "gbdt",
      boosting: { objective: "return" },
      cutoffShare: HIGH_PRECISION_CUTOFF_SHARE,
      goal: "return",
    },
    standalone: true,
  },
  {
    // User ask 2026-10-18 ("one new novel Profit-based model"). Profit's question asked another
    // way: not how much a coin will make, but whether its kind wins more money than it loses. Each
    // training call counts by the money it made or lost (a +500% call, the cap, 10x a stop-out), so the
    // score is gross gains over gross losses - the profit factor traders read a strategy by. A
    // classifier's gradient is bounded, so a few +500% runners can't own the fit as they can
    // Profit's squared error, and a flat coin that never sells barely counts (Profit learns
    // those are safe and leans to them). Walk-forward 10-11..10-17 on the 6,559 rule-4 rows
    // replayed under EXIT_PLAN, top 12% a day, two seeds: 2x 14.5% / 10.9%, stop 40%, -3.1% /
    // -8.0% a call, against Profit's 9.9% / 7.8%, 23-29%, -4.2% / -0.9% (market 14.4%, 54%,
    // -11.1%). Inside noise on return; it finds more doubles. The exam and live record decide.
    id: PROFIT_FACTOR_CONTESTANT,
    name: "Profit Factor",
    description:
      "Boosted trees on whether an alert made money under the exit plan, each training alert weighted by how much it made or lost (capped at +500%), so the score is the money won against the money lost by coins like it; alerting on about the top 8% of decision moments; judged on return",
    summary:
      "Learns which kinds of coins win more money than they lose, counting every past alert by what it actually made or lost, and alerts on the ones where the wins outweigh the losses most.",
    role: "learner",
    recipe: {
      learner: "gbdt",
      boosting: { objective: "payoff" },
      cutoffShare: HIGH_PRECISION_CUTOFF_SHARE,
      goal: "return",
    },
    standalone: true,
  },
  {
    // User ask 2026-10-17: a model on the traits of the best seats that only considers tokens
    // passing the Gemerald filter as it stood then (GEMERALD_GATE, frozen in ModelGate).
    id: GEMS_CONTESTANT,
    name: "Gems",
    description:
      "Only tokens that pass the Gemerald filter (a frozen copy): Survivor's two boosted-tree stages on every input but TokenSage's, mostly the last few days, alerting only on its surest tokens - about the top 8% of Gemerald's moments, moved by 2x record, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary:
      "Looks only at coins the Gemerald filter lets through, asks whether each will avoid a 50% drop and then double, and alerts only on the ones it is surest of.",
    role: "learner",
    recipe: GEMS_RECIPE,
    standalone: true,
    gate: GEMERALD_GATE,
  },
  {
    // User ask 2026-10-17: a model that learns from the best winner wallets, leaving out wallets
    // whose wins came from tokens transferred in. Decides only once the newest buyers were read.
    id: WINNERS_CONTESTANT,
    name: "Winners",
    description:
      "Who is buying and how, read through the best wallets' records: the clean Winner wallets' (no win fed by tokens transferred in) share of the newest buyers and of the SOL, the buyers' own 2x record, how hard the winners are buying against their usual stake and whether they are buying in or getting out, beside every input but TokenSage's. Survivor's two boosted-tree stages, mostly the last few days, alerting only on its surest tokens - about the top 8% of the moments the newest trades were read on, moved by 2x record, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary:
      "Watches which proven winning wallets are trading a coin right now and how (how big they are buying, whether they are getting in or out), leaving out wallets whose wins came from tokens sent to them, weighs that with the rest of the coin's picture, and alerts only on the ones it is surest of.",
    role: "learner",
    recipe: WINNERS_RECIPE,
    standalone: true,
    requires: "recentBuyersRead",
  },
  {
    id: NARRATIVE_CONTESTANT,
    name: "Story",
    description:
      "Two boosted-tree models trained on deep-read coins, blended at fixed weights: 30% the story (TokenSage's theme, lineage, trend match, X post, logo and creator fee, and the coin's socials) and 70% a safety check (holder concentration, fresh, empty and sniper wallets, launch bundles, the dev's buy, RugCheck risk); no price, volume or age. Decides only once TokenSage's deep read is in, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary:
      "Waits for the deep read of what the coin is about (its theme, its X post, copycat signs), then decides from that and a safety check, the safety check holding 70% of the say.",
    role: "narrative",
    recipe: {
      learner: "gbdt",
      featureNames: NARRATIVE_SEAT_FEATURES,
      narrativeLed: NARRATIVE_STORY_WEIGHT,
      goal: "return",
    },
  },
  {
    // The Narrative seat's two-step sibling (user decision 2026-10-08): the market and the
    // narrative each get a stage, so it weighs both, where the Narrative seat is mostly the
    // narrative. Same rows and the same deep-read gate; it files its own calls like a learner
    // seat (the agrees/warns note on other cards stays the Narrative seat's).
    id: NARRATIVE_BLEND_CONTESTANT,
    name: "Story + Market",
    description:
      "Two steps: boosted trees score the coin from every market input, then shallow trees trained on deep-read coins adjust that score by TokenSage's read, only as far as that beat the market score on the newest coins; decides only once the deep read is in, ranked on expected return under the exit plan (its 2x odds weighed against a separate crash-risk model, among the coins in the top 60% of its 2x odds)",
    summary:
      "Takes the market's read of the coin and TokenSage's deep read of its story, and weighs the two together.",
    role: "narrative",
    // Every learner input, TokenSage's included: its blend stage reads all of them, where the
    // market seats read MARKET_LEARNER_FEATURE_NAMES (its market stage drops the ns* inputs).
    recipe: { learner: "gbdt", narrativeBlend: true, featureNames: LEARNER_FEATURE_NAMES, goal: "return" },
  },
];

export const CONTESTANT_IDS: readonly string[] = CONTESTANTS.map((c) => c.id);

/** Seats that no longer run (see ContestantSpec.retired): their calls stay out of live stats. */
export const RETIRED_CONTESTANT_IDS: readonly string[] = CONTESTANTS.filter((c) => c.retired).map(
  (c) => c.id,
);

/** The seats that can run: every id but the retired ones (the roster's default). */
export const ACTIVE_CONTESTANT_IDS: readonly string[] = CONTESTANTS.filter((c) => !c.retired).map(
  (c) => c.id,
);

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
  // A retired id left in a configured list is skipped, not an error.
  const wanted = new Set(ids.filter((id) => !RETIRED_CONTESTANT_IDS.includes(id)));
  wanted.add(RULES_CONTESTANT);
  const learners = CONTESTANTS.filter((c) => isMemberLearner(c) && wanted.has(c.id));
  return CONTESTANTS.filter(
    (c) => wanted.has(c.id) && (!COMBINER_ROLES.includes(c.role) || learners.length >= 2),
  );
}
