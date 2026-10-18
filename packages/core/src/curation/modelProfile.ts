import { DEFAULT_BOOSTING_OPTIONS } from "./boosting.js";
import {
  MOMENTUM_FEATURES,
  ORDER_FLOW_FEATURES,
  TRADER_CONTESTANT,
  TRADER_CUTOFF_SHARE,
  TREES_NO_TOKENSAGE_FEATURES,
  type ContestantSpec,
} from "./contestants.js";
import type { SeatGoal } from "./trainer.js";

/**
 * A model in plain words, for the model window's picture of what it does (user ask 2026-10-17:
 * "better explanations / graphics of what they do"): what it aims for, what it looks at, how it
 * decides, how picky it is and how long it remembers. Worked out from the seat's spec and the
 * recipe holding it now, so a bred recipe taking a seat redraws the picture.
 */
export interface ModelProfile {
  /** What it is trained and judged on; "team" for the seats that combine the others, "rules" for Rules. */
  goal: SeatGoal | "team" | "rules";
  /** The goal in a few words, e.g. "Most profit a call". */
  goalText: string;
  /** What it looks at, e.g. "Every signal on the coin". */
  reads: string;
  /** How it turns that into a call, e.g. "Learns if-then rules". */
  decides: string;
  /** The shape the window draws for the method. */
  method:
    | "formula"
    | "trees"
    | "deep-trees"
    | "forest"
    | "two-step"
    | "regression"
    | "scales"
    | "team"
    | "rules"
    | "story";
  /** What it waits for before it decides, to follow "Decides only once it has"; null when it decides on every coin. */
  waitsFor: string | null;
  /** The share of decision moments its cutoff aims to call, in percent; null when its cutoff is set by the exam alone. */
  aimsToCallPct: number | null;
  /** How long it remembers: older rows count half after this many days; null for seats that don't train on rows. */
  memoryDays: number | null;
}

const GOAL_TEXT: Record<SeatGoal, string> = {
  "2x": "Coins that double",
  "4x": "Coins that go 4x",
  "10x": "Coins that go 10x",
  return: "Most profit per alert",
  safe: "Profit without the crashes",
  moonshot: "The biggest runs",
  catch: "Catch as many runners as it can",
};

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((n) => b.includes(n));

export function modelProfile(spec: ContestantSpec, baseHalfLifeDays: number): ModelProfile {
  const r = spec.recipe;
  const base = { waitsFor: null, aimsToCallPct: null, memoryDays: null } as const;
  switch (spec.role) {
    case "rules":
      return {
        ...base,
        goal: "rules",
        goalText: "A simple, readable fallback",
        reads: "A few checks on the coin",
        decides: "Adds up points and alerts past a cutoff",
        method: "rules",
      };
    case "stacked":
      return {
        ...base,
        goal: "team",
        goalText:
          spec.id === TRADER_CONTESTANT ? "The surest alerts, for the trading bot" : "Alerts the team backs",
        reads: "The other models' alerts",
        decides:
          spec.id === TRADER_CONTESTANT
            ? "Learns which models to trust"
            : "Learns which models to trust, and needs three of them alerting",
        method: "team",
        aimsToCallPct: spec.id === TRADER_CONTESTANT ? TRADER_CUTOFF_SHARE * 100 : null,
      };
    case "blend":
      return {
        ...base,
        goal: "team",
        goalText: "Alerts the team backs",
        reads: "The other models' confidence",
        decides: "Averages it, nothing learned",
        method: "team",
      };
    case "agreement":
      return {
        ...base,
        goal: "team",
        goalText: "Alerts the team backs",
        reads: "The other models' alerts",
        decides: "Counts how many agree",
        method: "team",
      };
    case "topslice":
      return {
        ...base,
        goal: "team",
        goalText: "Only the surest alerts",
        reads: "The tree models' alerts",
        decides: "Keeps an alert one of them is most sure of",
        method: "team",
      };
  }

  const goal: SeatGoal = r?.goal ?? "2x";
  const memoryDays = r?.recencyHalfLifeDays ?? baseHalfLifeDays;
  const features = r?.featureNames;
  let reads = "Every signal on the coin";
  if (spec.gate) reads = "Only coins the Gemerald filter lets through";
  else if (spec.requires === "recentBuyersRead")
    reads = "Which proven winning wallets are buying, and the rest of the coin";
  else if (r?.narrativeLed) reads = "TokenSage's read of the story, and safety checks";
  else if (r?.narrativeBlend) reads = "The market, then TokenSage's read of the story";
  else if (features && same(features, ORDER_FLOW_FEATURES)) reads = "The last few minutes of trading";
  else if (features && same(features, MOMENTUM_FEATURES))
    reads = "The last half hour's price and the market's mood";
  else if (features && same(features, TREES_NO_TOKENSAGE_FEATURES))
    reads = "Every signal except TokenSage's read";
  else if (features) reads = `${features.length} chosen signals`;

  let method: ModelProfile["method"];
  let decides: string;
  if (r?.narrativeLed) {
    method = "story";
    decides = "A story model and a safety model, safety holding most of the say";
  } else if (r?.narrativeBlend) {
    method = "story";
    decides = "Scores the market, then adjusts by the story";
  } else if (r?.twoStage) {
    method = "two-step";
    decides = "Asks two questions: will it dodge a 50% drop, then will it double";
  } else if (r?.learner === "logistic") {
    method = "formula";
    decides = "Weighs each signal in one formula";
  } else if (r?.learner === "forest") {
    method = "forest";
    decides = "Many independent trees vote";
  } else if (r?.boosting?.objective === "return") {
    method = "regression";
    decides = "Predicts the profit an alert makes";
  } else if (r?.boosting?.objective === "payoff") {
    method = "scales";
    decides = "Weighs the money coins like it won against what they lost";
  } else if (r?.boosting?.objective === "runSize") {
    method = "trees";
    decides = "Predicts how far the coin runs";
  } else if ((r?.boosting?.maxDepth ?? DEFAULT_BOOSTING_OPTIONS.maxDepth) >= 5) {
    method = "deep-trees";
    decides = "Learns long if-then chains";
  } else {
    method = "trees";
    decides = "Learns if-then rules";
  }

  const share = r?.cutoffShare ?? null;
  return {
    goal,
    goalText: GOAL_TEXT[goal],
    reads,
    decides,
    method,
    waitsFor:
      spec.role === "narrative"
        ? "TokenSage's deep read of the coin"
        : spec.requires === "recentBuyersRead"
          ? "a read of the newest buyers"
          : spec.gate
            ? "the Gemerald filter's go-ahead"
            : null,
    aimsToCallPct: share !== null ? Math.round(share * 1000) / 10 : null,
    memoryDays,
  };
}
