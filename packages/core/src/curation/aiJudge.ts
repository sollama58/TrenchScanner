import { GOAL_LABEL, recordScore } from "./leaderboard.js";
import type { PrecisionTargets } from "./trainer.js";
import { GOAL_MULTIPLE, GOAL_WINDOW_MINUTES, WIN_MULTIPLE, WIN_WINDOW_MINUTES } from "./labels.js";
import { MAX_PLAYBOOK_CHARS } from "./aiReview.js";

/**
 * The AI judge's learning loop, pure half. The reviewer (apps/worker/src/ai/reviewer.ts) answers
 * from a fixed system prompt plus a PLAYBOOK - lessons learned from its own graded record. The
 * loop that improves the playbook (apps/worker/src/ai/playbook.ts) works in batches and in
 * versions, never call by call: one graded outcome at a 30-50% base rate is mostly noise, and a
 * prompt that drifted with every call would never hold still long enough to earn a record.
 *
 *  1. A review call reads hundreds of graded calls - numbers and outcomes only, never the
 *     launcher-written text, so no token can write itself into the playbook - and proposes
 *     candidate playbooks (buildReflectionBrief).
 *  2. Each candidate and the incumbent are replayed on recent graded alerts the review never saw,
 *     through the Message Batches API, and scored the same way (summarizeJudgeRecord).
 *  3. A candidate takes over only when it beats the incumbent clearly (decidePlaybookPromotion).
 */

/** One graded verdict - live (AiReview) or replayed (AiReplayVerdict). */
export interface JudgedCall {
  decision: "buy" | "no_buy" | null;
  probability2x: number | null;
  /** The alert's graded label: 0 = loss, log2(peak multiple) for a clean win. */
  labelValue: number;
  /** The default model's own 2x probability, when it had one - for the side-by-side Brier. */
  curatorProbability?: number | null;
}

export interface JudgeRecordSummary {
  /** Graded calls that got a verdict. */
  reviewed: number;
  buys: number;
  /** Of the buys: clean 2x / 4x rates, %. */
  buyWinRatePct: number | null;
  buyGoalRatePct: number | null;
  /** Of every reviewed call - the pool the reviewer filters: its base rates, %. */
  baseWinRatePct: number | null;
  baseGoalRatePct: number | null;
  /** buyWinRatePct - baseWinRatePct, in points: what the reviewer adds over sending everything. */
  liftPts: number | null;
  /** Share of the pool's winners it said no to, %. */
  missedWinnersPct: number | null;
  /** Mean squared error of probability2x against the 2x outcome; lower is better, 0.25 = a coin. */
  brier: number | null;
  /** The same for the default model's own probability, on the calls that had one. */
  curatorBrier: number | null;
  /** The buy record's composite, 0-100 - the leaderboard formula (recordScore). */
  score: number | null;
}

const pct = (hits: number, n: number) => (n > 0 ? (hits / n) * 100 : null);

function brierOf(pairs: { p: number; won: boolean }[]): number | null {
  if (pairs.length === 0) return null;
  return pairs.reduce((s, { p, won }) => s + (p - (won ? 1 : 0)) ** 2, 0) / pairs.length;
}

/** Scores a set of graded verdicts on the feed's own terms - see JudgeRecordSummary. */
export function summarizeJudgeRecord(calls: JudgedCall[], targets: PrecisionTargets): JudgeRecordSummary {
  const reviewed = calls.filter((c) => c.decision !== null);
  const buys = reviewed.filter((c) => c.decision === "buy");
  const won = (c: JudgedCall) => c.labelValue > 0;
  const goal = (c: JudgedCall) => c.labelValue >= GOAL_LABEL;
  const buyWins = buys.filter(won).length;
  const buyGoals = buys.filter(goal).length;
  const baseWins = reviewed.filter(won).length;
  const baseWinRatePct = pct(baseWins, reviewed.length);
  const buyWinRatePct = pct(buyWins, buys.length);
  const missed = reviewed.filter((c) => c.decision === "no_buy" && won(c)).length;
  return {
    reviewed: reviewed.length,
    buys: buys.length,
    buyWinRatePct,
    buyGoalRatePct: pct(buyGoals, buys.length),
    baseWinRatePct,
    baseGoalRatePct: pct(reviewed.filter(goal).length, reviewed.length),
    liftPts: buyWinRatePct !== null && baseWinRatePct !== null ? buyWinRatePct - baseWinRatePct : null,
    missedWinnersPct: pct(missed, baseWins),
    brier: brierOf(
      reviewed.flatMap((c) => (c.probability2x === null ? [] : [{ p: c.probability2x, won: won(c) }])),
    ),
    curatorBrier: brierOf(
      reviewed.flatMap((c) =>
        c.curatorProbability === null || c.curatorProbability === undefined
          ? []
          : [{ p: c.curatorProbability, won: won(c) }],
      ),
    ),
    score: recordScore(
      {
        calls: buys.length,
        graded: buys.length,
        wins: buyWins,
        goals: buyGoals,
        sumLabel: buys.reduce((s, c) => s + Math.max(0, c.labelValue), 0),
      },
      targets,
    ),
  };
}

export interface PromotionRules {
  /** Composite points a candidate must beat the incumbent by. */
  minGain: number;
  /** Buy calls a candidate's replay must make for its record to count. */
  minBuys: number;
  /** How much worse a candidate's Brier may be than the incumbent's and still win. */
  maxBrierLoss?: number;
}

export interface PromotionDecision {
  /** The candidate id to promote, or null to keep the incumbent. */
  winner: string | null;
  /** One line, for the log and the Models tab. */
  reason: string;
}

/**
 * Whether any candidate earned the job on a replay all of them ran on identical alerts: the best
 * composite wins, if it has enough buys to judge, beats the incumbent by minGain points, and its
 * odds are no worse calibrated than the incumbent's (beyond maxBrierLoss). Ties keep the incumbent.
 */
export function decidePlaybookPromotion(
  incumbent: JudgeRecordSummary,
  candidates: { id: string; summary: JudgeRecordSummary }[],
  rules: PromotionRules,
): PromotionDecision {
  const maxBrierLoss = rules.maxBrierLoss ?? 0.01;
  const eligible = candidates.filter((c) => c.summary.buys >= rules.minBuys && c.summary.score !== null);
  if (eligible.length === 0) {
    return { winner: null, reason: `no candidate made ${rules.minBuys}+ buy calls on the replay` };
  }
  const best = [...eligible].sort((a, b) => (b.summary.score ?? 0) - (a.summary.score ?? 0))[0]!;
  const bestScore = best.summary.score ?? 0;
  const incumbentScore = incumbent.score ?? 0;
  if (bestScore < incumbentScore + rules.minGain) {
    return {
      winner: null,
      reason: `best candidate scored ${bestScore.toFixed(1)} vs incumbent ${incumbentScore.toFixed(1)}; needs +${rules.minGain}`,
    };
  }
  // A playbook whose buys don't beat the replay's own base rate is no better than picking at
  // random, whatever its composite - and an incumbent that rarely says buy scores null (0 here),
  // so without this any candidate with a few lucky buys would take over.
  if (best.summary.liftPts === null || best.summary.liftPts <= 0) {
    return {
      winner: null,
      reason: `best candidate's buys won no more often than the replay's base rate (lift ${best.summary.liftPts?.toFixed(1) ?? "n/a"} pts)`,
    };
  }
  if (
    best.summary.brier !== null &&
    incumbent.brier !== null &&
    best.summary.brier > incumbent.brier + maxBrierLoss
  ) {
    return {
      winner: null,
      reason: `best candidate's odds were worse calibrated (Brier ${best.summary.brier.toFixed(3)} vs ${incumbent.brier.toFixed(3)})`,
    };
  }
  return {
    winner: best.id,
    reason: `candidate scored ${bestScore.toFixed(1)} vs incumbent ${incumbentScore.toFixed(1)} on the same replay`,
  };
}

/** One graded call as the evolution review sees it: numbers and outcome, never the token's text. */
export interface ReflectionCall {
  decision: "buy" | "no_buy";
  probability2x: number | null;
  labelValue: number;
  /** Fell to the stop before any 2x. */
  stoppedOut: boolean;
  peak1hReturnPct: number | null;
  curatorProbability: number | null;
  features: Record<string, number | null | undefined>;
}

/**
 * The inputs the review reads per call, with the label the reviewer's own brief uses for each -
 * so a lesson the review writes ("distinct buyers in the last 5 minutes under 20") names
 * something the reviewer can actually see.
 */
const REFLECTION_COLUMNS: { key: string; label: string; fmt: (v: number) => string }[] = [
  { key: "mcapUsd", label: "market cap $k", fmt: (v) => (v / 1000).toFixed(0) },
  { key: "ageMinutes", label: "age min", fmt: (v) => v.toFixed(0) },
  { key: "graduated", label: "graduated", fmt: (v) => (v === 1 ? "y" : "n") },
  { key: "priceChange5mPct", label: "price change 5m %", fmt: (v) => v.toFixed(0) },
  { key: "priceChange1hPct", label: "price change 1h %", fmt: (v) => v.toFixed(0) },
  { key: "buyRatio1h", label: "1h buys share %", fmt: (v) => (v * 100).toFixed(0) },
  { key: "volume1hToMcapRatio", label: "1h volume / mcap", fmt: (v) => v.toFixed(2) },
  { key: "holderCount", label: "holders", fmt: (v) => v.toFixed(0) },
  { key: "top10HolderPct", label: "top 10 hold %", fmt: (v) => v.toFixed(0) },
  { key: "freshTop10WalletPct", label: "top-10 brand-new wallets %", fmt: (v) => v.toFixed(0) },
  { key: "emptyTop10WalletPct", label: "top-10 empty wallets %", fmt: (v) => v.toFixed(0) },
  { key: "sniperTop10WalletPct", label: "top-10 launch snipers %", fmt: (v) => v.toFixed(0) },
  { key: "uniqueBuyers5m", label: "distinct buyers 5m", fmt: (v) => v.toFixed(0) },
  { key: "buysPerBuyer5m", label: "buys per buyer 5m", fmt: (v) => v.toFixed(1) },
  { key: "topBuyerShare5m", label: "biggest buyer share %", fmt: (v) => (v * 100).toFixed(0) },
  { key: "netFlow5mToMcap", label: "net SOL flow 5m vs mcap %", fmt: (v) => (v * 100).toFixed(2) },
  { key: "earlyBuyerHoldPct", label: "launch snipers hold %", fmt: (v) => v.toFixed(1) },
  { key: "earlyBuyerSoldShare", label: "launch snipers sold %", fmt: (v) => (v * 100).toFixed(0) },
  { key: "devSoldShare", label: "dev sold %", fmt: (v) => (v * 100).toFixed(0) },
  { key: "devHolding", label: "dev still holding", fmt: (v) => (v === 1 ? "y" : "n") },
  { key: "firstBuyersHolding", label: "first 25 buyers still holding", fmt: (v) => v.toFixed(0) },
];

/** How many calls one review reads - the wrong ones first, see buildReflectionBrief. */
export const MAX_REFLECTION_CALLS = 250;

export const REFLECTION_SYSTEM_PROMPT = `You improve the playbook of an AI reviewer that judges Solana memecoin alerts for a trader who buys by hand.

The reviewer sees each alert's market, holder and order-flow numbers plus its text, and answers buy or no_buy with its odds. An alert WINS if it reaches ${WIN_MULTIPLE}x the alert price within ${WIN_WINDOW_MINUTES} minutes without first falling to half (a stop-out). The trader's aim: 75% of buys win and 50% reach ${GOAL_MULTIPLE}x within ${GOAL_WINDOW_MINUTES} minutes. Missing a winner costs far less than buying a loser.

Its playbook is a short list of lessons appended to its fixed instructions. You get the current playbook and a graded record of the reviewer's recent calls: what it said, its odds, the key numbers it saw, and what happened.

Write two candidate replacement playbooks. Each must be a complete playbook, not a diff, under ${Math.floor(MAX_PLAYBOOK_CHARS / 2)} characters, as short plain rules. For each candidate:
- Base every rule on a pattern that holds across many calls in the record, and say roughly how many in the rationale. One or two calls are noise; never write a rule from them.
- Name inputs with the labels the record uses, and give thresholds as numbers.
- Keep rules from the current playbook that the record supports, and drop or fix the ones it contradicts.
- Address the costliest mistakes first: buys that lost, then winners it passed on.
Make the first candidate a careful refinement of the current playbook and the second a bolder change. Each candidate gets a one- or two-sentence rationale.

Both candidates will be tested on recent alerts you have not seen, and one replaces the current playbook only if it beats it there.`;

const fmtCell = (v: number | null | undefined, fmt: (v: number) => string) =>
  v === null || v === undefined || !Number.isFinite(v) ? "?" : fmt(v);

/**
 * The review's user turn: the current playbook, a summary of the record, then the calls as a
 * table - the costly mistakes first (buys that lost, then winners it passed on), then the rest,
 * up to MAX_REFLECTION_CALLS. Numbers and outcomes only.
 */
export function buildReflectionBrief(currentPlaybook: string, calls: ReflectionCall[]): string {
  const rank = (c: ReflectionCall) =>
    c.decision === "buy" && c.labelValue <= 0 ? 0 : c.decision === "no_buy" && c.labelValue > 0 ? 1 : 2;
  const listed = [...calls].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_REFLECTION_CALLS);
  const buys = calls.filter((c) => c.decision === "buy");
  const passes = calls.filter((c) => c.decision === "no_buy");
  const winRate = (cs: ReflectionCall[]) =>
    cs.length === 0 ? "n/a" : `${Math.round((cs.filter((c) => c.labelValue > 0).length / cs.length) * 100)}%`;
  const goalRate = (cs: ReflectionCall[]) =>
    cs.length === 0
      ? "n/a"
      : `${Math.round((cs.filter((c) => c.labelValue >= GOAL_LABEL).length / cs.length) * 100)}%`;

  const header = [
    "decision",
    "its 2x odds %",
    "model 2x odds %",
    ...REFLECTION_COLUMNS.map((c) => c.label),
    "outcome",
  ].join(" | ");
  const rows = listed.map((c) => {
    const outcome =
      c.labelValue > 0
        ? `WON peak ${fmtCell(c.peak1hReturnPct, (x) => `+${Math.round(x)}%`)}`
        : c.stoppedOut
          ? "STOPPED OUT"
          : `missed peak ${fmtCell(c.peak1hReturnPct, (x) => `${x >= 0 ? "+" : ""}${Math.round(x)}%`)}`;
    return [
      c.decision,
      fmtCell(c.probability2x, (x) => (x * 100).toFixed(0)),
      fmtCell(c.curatorProbability, (x) => (x * 100).toFixed(0)),
      ...REFLECTION_COLUMNS.map((col) => fmtCell(c.features[col.key], col.fmt)),
      outcome,
    ].join(" | ");
  });

  return [
    `current playbook:`,
    currentPlaybook.trim() === ""
      ? "(empty - the reviewer runs on its fixed instructions alone)"
      : currentPlaybook,
    ``,
    `record: ${calls.length} graded calls.`,
    `- buys: ${buys.length}, ${winRate(buys)} won, ${goalRate(buys)} reached ${GOAL_MULTIPLE}x`,
    `- passes: ${passes.length}, ${winRate(passes)} would have won, ${goalRate(passes)} would have reached ${GOAL_MULTIPLE}x`,
    `- every call: ${winRate(calls)} won`,
    ``,
    `calls (${listed.length} shown, mistakes first; "?" = unknown):`,
    header,
    ...rows,
  ].join("\n");
}
