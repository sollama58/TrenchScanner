import {
  prisma,
  AGREEMENT_MODEL_KIND,
  BLEND_MODEL_KIND,
  BOOSTED_MODEL_KIND,
  CURATOR_MODEL_KIND,
  NARRATIVE_BLEND_MODEL_KIND,
  RULES_MODEL_KIND,
  STACKED_MODEL_KIND,
  TOP_SLICE_MODEL_KIND,
  TWO_STAGE_MODEL_KIND,
  AGREEMENT_SIGNAL,
  RULES_GATE_SIGNAL,
  RULES_RANK_SIGNAL,
  agreeingFromScore,
  featureContributions,
  inputLabel,
  memberCalls,
  memberSignalName,
  scoreRuleSet,
  NEVER_EMIT_THRESHOLD,
  rankFromQuantiles,
  scoreAgreement,
  scoreBlend,
  scoreCandidateWithModel,
  scoreTopSlice,
  type AgreementCuratorParams,
  type BlendCuratorParams,
  type BoostedCuratorParams,
  type CalibrationKnot,
  type ContestantParams,
  type ContestantRole,
  type Env,
  type LogisticCuratorParams,
  type StackedCuratorParams,
  type StackedMember,
  type StoredEvalMetrics,
  type TopSliceCuratorParams,
  type TrainedCuratorParams,
} from "@trenchscanner/core";
import { contestState } from "./contest.js";

/**
 * The Admin "Models" section: how each seat makes its calls. Everything here is read back from
 * what the training job stored (params and evalMetrics) and what the worker wrote on each call,
 * or recomputed from them with the same scoring code the worker runs - nothing is fitted here and
 * nothing here changes what is emitted. Admin-only (routes/adminModels.ts).
 */

const HOUR_MS = 3_600_000;

/** Recent decision moments the input attributions are averaged over. */
export const ATTRIBUTION_SAMPLE_ROWS = 1200;
/** How far back those moments may come from. */
const ATTRIBUTION_SAMPLE_HOURS = 48;
/** Inputs each seat's chart lists. */
const TOP_INPUTS = 12;
/** Seats whose exam cutoff (precisionCalibration.threshold) is a confidence rank. */
const RANK_CUTOFF_ROLES: readonly ContestantRole[] = ["learner", "narrative", "stacked"];

type Features = Record<string, number | null | undefined>;

const LEARNER_KINDS: readonly string[] = [
  CURATOR_MODEL_KIND,
  BOOSTED_MODEL_KIND,
  TWO_STAGE_MODEL_KIND,
  NARRATIVE_BLEND_MODEL_KIND,
];

function isLearnerParams(p: ContestantParams | null): p is TrainedCuratorParams {
  return p !== null && LEARNER_KINDS.includes(p.kind);
}

function asFeatures(value: unknown): Features | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Features) : null;
}

async function loadParams(id: string): Promise<ContestantParams | null> {
  const row = await prisma.curatorModel.findUnique({ where: { id }, select: { params: true } });
  const params = row?.params as ContestantParams | null | undefined;
  return params && typeof params === "object" && typeof params.kind === "string" ? params : null;
}

/** Deepest root-to-leaf path in a tree stored as parallel arrays (-1 = leaf). */
function treeDepth(tree: { feature: number[]; left: number[]; right: number[] }): number {
  let deepest = 0;
  const stack: [number, number][] = [[0, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if ((tree.feature[node] ?? -1) < 0) {
      deepest = Math.max(deepest, depth);
      continue;
    }
    stack.push([tree.left[node]!, depth + 1], [tree.right[node]!, depth + 1]);
  }
  return deepest;
}

export interface RecipeFact {
  label: string;
  value: string;
}

function familyFacts(
  prefix: string,
  p: Omit<LogisticCuratorParams, "threshold"> | Omit<BoostedCuratorParams, "threshold">,
) {
  const facts: RecipeFact[] = [];
  if (p.kind === BOOSTED_MODEL_KIND) {
    const family = p.family === "forest" ? "Random forest" : "Boosted trees";
    const objective =
      p.objective === "lambdarank"
        ? "the order of each hour's coins (LambdaRank)"
        : p.objective === "runSize"
          ? "how far a winner runs"
          : "the chance of a clean 2x";
    facts.push(
      { label: `${prefix}Family`, value: family },
      { label: `${prefix}Fitted to`, value: objective },
      { label: `${prefix}Trees`, value: String(p.trees.length) },
      {
        label: `${prefix}Deepest tree`,
        value: `${p.trees.reduce((d, t) => Math.max(d, treeDepth(t)), 0)} splits`,
      },
      { label: `${prefix}Inputs`, value: String(p.featureNames.length) },
    );
  } else {
    facts.push(
      { label: `${prefix}Family`, value: "Logistic (one weight per input)" },
      { label: `${prefix}Inputs`, value: String(p.featureNames.length) },
    );
  }
  return facts;
}

/** The model's shape in a few plain facts, read off its stored params. */
export function recipeFacts(params: ContestantParams, metrics: Partial<StoredEvalMetrics>): RecipeFact[] {
  const facts: RecipeFact[] = [];
  switch (params.kind) {
    case CURATOR_MODEL_KIND:
    case BOOSTED_MODEL_KIND:
      facts.push(...familyFacts("", params));
      break;
    case TWO_STAGE_MODEL_KIND:
      facts.push(
        { label: "Shape", value: "Two stages: survives the hour x doubles if it survives" },
        ...familyFacts("Survival stage: ", params.survival),
        ...familyFacts("Win stage: ", params.win),
      );
      break;
    case NARRATIVE_BLEND_MODEL_KIND:
      facts.push(
        { label: "Shape", value: "Two steps: the market's read, then TokenSage's on top" },
        ...familyFacts("Market step: ", params.market),
        ...familyFacts("Narrative step: ", params.blend),
      );
      break;
    case STACKED_MODEL_KIND:
      facts.push(
        { label: "Shape", value: "Logistic model over the members' ranks (stacked)" },
        { label: "Members", value: `${params.members.length} learners + Rules` },
      );
      break;
    case BLEND_MODEL_KIND:
      facts.push(
        { label: "Shape", value: "Average of the members' ranks, highest and lowest dropped" },
        { label: "Members", value: String(params.members.length) },
      );
      break;
    case AGREEMENT_MODEL_KIND:
      facts.push(
        { label: "Shape", value: "Counts how many members call the coin at their own cutoff" },
        { label: "Members", value: String(params.members.length) },
      );
      break;
    case TOP_SLICE_MODEL_KIND:
      facts.push(
        { label: "Shape", value: "Calls a coin one tree seat ranks in the top quarter of its own calls" },
        { label: "Members", value: String(params.members.length) },
      );
      break;
    case RULES_MODEL_KIND:
      facts.push({
        label: "Shape",
        value: params.derived
          ? `Points table learned from ${params.derived.teacher.name}`
          : "Hand-tuned checks on the scanner's score",
      });
      break;
  }
  const lean = metrics.trainingWeightByAge;
  if (lean) {
    facts.push({
      label: "Memory",
      value:
        lean.halfLifeDays === null
          ? "Every training day counts the same"
          : `Half-life ${lean.halfLifeDays} days: the last day carries ${Math.round(lean.weightPct.d1)}% of the weight`,
    });
  }
  return facts;
}

export interface InputWeight {
  feature: string;
  label: string;
  /** Share of the model's total push, 0-100. */
  sharePct: number;
  /** +1 more pushes toward a call, -1 away; null when it isn't one-way (trees). */
  direction: 1 | -1 | null;
  /** Mean push (log-odds) on the moments it called in the sample; null without any. */
  onCalls: number | null;
}

interface Accumulator {
  label: Map<string, string>;
  abs: Map<string, number>;
  signed: Map<string, number>;
  /** Sum of value x push, to read a direction off a one-way logistic input. */
  rows: number;
  calls: number;
}

function accumulator(): Accumulator {
  return { label: new Map(), abs: new Map(), signed: new Map(), rows: 0, calls: 0 };
}

function addContributions(
  acc: Accumulator,
  contributions: { name: string; value: number }[],
  called: boolean,
) {
  acc.rows += 1;
  if (called) acc.calls += 1;
  // Merge an input's value and missing-indicator (already one name) and inputs sharing a label.
  for (const c of contributions) {
    if (!Number.isFinite(c.value)) continue;
    const label = inputLabel(c.name);
    acc.label.set(label, c.name);
    acc.abs.set(label, (acc.abs.get(label) ?? 0) + Math.abs(c.value));
    if (called) acc.signed.set(label, (acc.signed.get(label) ?? 0) + c.value);
  }
}

/**
 * What a learner leans on over recent decision moments: each input's mean absolute push on the
 * score (the path attribution for trees, weight x standardized value for the logistic) as a share
 * of all of them - the mean-|attribution| importance - and its mean signed push on the moments the
 * model called. Unlike a split count this weighs a split by how much it moved the score.
 */
function inputWeights(acc: Accumulator, params: TrainedCuratorParams): InputWeight[] {
  const total = [...acc.abs.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) return [];
  const logistic = params.kind === CURATOR_MODEL_KIND ? params : null;
  return [...acc.abs]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_INPUTS)
    .map(([label, v]) => {
      const feature = acc.label.get(label) ?? label;
      const j = logistic ? logistic.featureNames.indexOf(feature) : -1;
      return {
        feature,
        label,
        sharePct: Math.round((v / total) * 1000) / 10,
        direction: j >= 0 ? ((logistic!.weights[j] ?? 0) >= 0 ? 1 : -1) : null,
        onCalls: acc.calls > 0 ? Math.round(((acc.signed.get(label) ?? 0) / acc.calls) * 1000) / 1000 : null,
      };
    });
}

export interface MemberWeight {
  contestant: string;
  name: string;
  /** The member's own cutoff as the share of decision moments it calls, in percent. */
  callsTopPct: number | null;
  /** Consensus only: the meta model's share of weight on this member, 0-100, and its sign. */
  weightPct: number | null;
  direction: 1 | -1 | null;
  /** On the combiner's calls in the sample: the share where this member was calling too. */
  backingPct: number | null;
}

/** The consensus meta model's weights per signal, as shares (standardized, so comparable). */
function metaWeights(params: StackedCuratorParams): Map<string, { sharePct: number; direction: 1 | -1 }> {
  const meta = params.meta;
  const n = meta.featureNames.length;
  const raw = meta.featureNames.map((f, j) => ({
    f,
    v: Math.abs(meta.weights[j] ?? 0) + Math.abs(meta.weights[n + j] ?? 0),
    s: (meta.weights[j] ?? 0) >= 0 ? (1 as const) : (-1 as const),
  }));
  const total = raw.reduce((s, r) => s + r.v, 0);
  return new Map(
    raw.map((r) => [
      r.f,
      { sharePct: total > 0 ? Math.round((r.v / total) * 1000) / 10 : 0, direction: r.s },
    ]),
  );
}

/** The combiner's rule in a sentence. */
export function combinerRule(params: ContestantParams, memberCount: number): string | null {
  switch (params.kind) {
    case AGREEMENT_MODEL_KIND: {
      const need = Math.max(1, agreeingFromScore(params.threshold, memberCount));
      return `Calls when at least ${need} of ${memberCount} members call the coin at their own cutoff; ties go to the coin the members rank highest.`;
    }
    case BLEND_MODEL_KIND:
      return `Calls when the members' average rank (highest and lowest dropped) is at least ${params.threshold.toFixed(3)}, where 0.990 means "above 99% of decision moments".`;
    case TOP_SLICE_MODEL_KIND:
      return "Calls when any one member ranks the coin in the top quarter of its own calls.";
    case STACKED_MODEL_KIND:
      return "A logistic model weighs every member's rank, Rules' score and how many members agree, then calls above its own cutoff.";
    default:
      return null;
  }
}

function callsTopPct(rank: number | null | undefined): number | null {
  return rank === null || rank === undefined ? null : Math.round((1 - rank) * 1000) / 10;
}

export interface SeatExplain {
  id: string;
  name: string;
  role: ContestantRole;
  description: string;
  summary: string;
  isDefault: boolean;
  control: boolean;
  status: "calling" | "silent" | "untrained";
  model: {
    id: string;
    kind: string;
    trainedAt: Date;
    trainingRows: number;
  } | null;
  facts: RecipeFact[];
  cutoff: {
    /**
     * Share of decision moments its cutoff calls, in percent: as the exam set it (fromExam), or,
     * for a seat whose cutoff is in its own score units, the share of recent moments it clears.
     */
    callsTopPct: number | null;
    fromExam: boolean;
    /** The exam's 2x rate at that cutoff, and on how many calls. */
    examWinRatePct: number | null;
    examCalls: number | null;
    meetsTargets: boolean | null;
    /** Share of decision moments its high-conviction tier starts at, when it earned one. */
    highTopPct: number | null;
    /** The share of the recent sample it would have called (learners and the simple combiners). */
    sampleCallsPct: number | null;
  };
  calls: { lastHour: number; last24h: number; last7d: number; perHour24h: number; lastAt: Date | null };
  /** The card's calibrated % by rank: what the cutoff and tiers mean in 2x rate. */
  calibration: { knots: CalibrationKnot[]; calls: number; windowFrom: string; windowTo: string } | null;
  /** Agreement only: the exam's 2x rate by how many members called. */
  agreementCurve: { agreeing: number; rows: number; winRatePct: number | null }[] | null;
  inputs: InputWeight[] | null;
  /** How many sample moments the inputs were averaged over, and how many it called. */
  inputSample: { rows: number; calls: number } | null;
  members: MemberWeight[] | null;
  /** Consensus only: the weight on signals that aren't a member's rank. */
  otherSignals: { label: string; weightPct: number; direction: 1 | -1 }[] | null;
  rule: string | null;
  rules: { source: string; lines: string[]; reason: string; teacherName: string | null } | null;
}

export interface ModelLineup {
  builtAt: Date;
  defaultModel: string;
  aiReviewMode: string;
  /** Decision moments the scanner banked per hour over the last 24 hours (event rows). */
  momentsPerHour: number;
  sample: { rows: number; from: Date | null; to: Date | null; deepReadRows: number };
  seats: SeatExplain[];
}

async function callCounts() {
  const now = Date.now();
  const window = (hours: number) =>
    prisma.curatedAlert.groupBy({
      by: ["model"],
      where: { createdAt: { gte: new Date(now - hours * HOUR_MS) } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
  const [h1, d1, d7] = await Promise.all([window(1), window(24), window(24 * 7)]);
  const map = new Map<string, SeatExplain["calls"]>();
  for (const r of d7) {
    if (!r.model) continue;
    map.set(r.model, {
      lastHour: 0,
      last24h: 0,
      last7d: r._count._all,
      perHour24h: 0,
      lastAt: r._max.createdAt,
    });
  }
  for (const r of d1) {
    const c = r.model ? map.get(r.model) : undefined;
    if (c) {
      c.last24h = r._count._all;
      c.perHour24h = Math.round((r._count._all / 24) * 100) / 100;
    }
  }
  for (const r of h1) {
    const c = r.model ? map.get(r.model) : undefined;
    if (c) c.lastHour = r._count._all;
  }
  return map;
}

/**
 * Every seat: its recipe, its cutoff in plain units, how often it calls, what it leans on (the
 * learners, attributed over recent decision moments) and how it weighs its members (the
 * combiners). Loads each active model's params one at a time and lets it go, since a forest's
 * params run to megabytes.
 */
export async function buildModelLineup(env: Env): Promise<ModelLineup> {
  const state = await contestState(env);
  const since = new Date(Date.now() - ATTRIBUTION_SAMPLE_HOURS * HOUR_MS);
  const [calls, sampleRows, moments24h] = await Promise.all([
    callCounts(),
    prisma.candidateOutcome.findMany({
      where: { sampleKind: "event", anchorAt: { gte: since } },
      orderBy: { anchorAt: "desc" },
      take: ATTRIBUTION_SAMPLE_ROWS,
      select: { anchorAt: true, features: true },
    }),
    prisma.candidateOutcome.count({
      where: { sampleKind: "event", anchorAt: { gte: new Date(Date.now() - 24 * HOUR_MS) } },
    }),
  ]);
  const sample = sampleRows.map((r) => asFeatures(r.features)).filter((f): f is Features => f !== null);
  const deepRead = sample.filter((f) => f.nsDepthFull === 1);
  const names = new Map(state.roster.map((c) => [c.id, c.name]));

  // Learners first: the combiners read their probabilities on the same moments.
  const probabilities = new Map<string, Float64Array>();
  const seats = new Map<string, SeatExplain>();
  const ordered = [
    ...state.roster.filter((c) => c.role === "learner" || c.role === "narrative" || c.role === "rules"),
    ...state.roster.filter((c) => c.role !== "learner" && c.role !== "narrative" && c.role !== "rules"),
  ];

  for (const spec of ordered) {
    const current = state.current.get(spec.id) ?? null;
    const metrics = current?.metrics ?? {};
    const params = current ? await loadParams(current.id) : null;
    const status: SeatExplain["status"] =
      spec.role === "rules"
        ? "calling"
        : current === null
          ? "untrained"
          : current.threshold !== null && current.threshold < NEVER_EMIT_THRESHOLD
            ? "calling"
            : "silent";
    const exam = metrics.precisionCalibration;
    const seat: SeatExplain = {
      id: spec.id,
      name: spec.name,
      role: spec.role,
      description: spec.description,
      summary: spec.summary ?? spec.description,
      isDefault: spec.id === state.defaultModel,
      control: spec.control === true,
      status,
      model: current
        ? {
            id: current.id,
            kind: current.kind,
            trainedAt: current.trainedAt,
            trainingRows: current.trainingRows,
          }
        : null,
      facts: params ? recipeFacts(params, metrics) : [],
      cutoff: {
        // Learners and the consensus set their cutoff as a rank; Rules, Agreement, Blend and Top
        // Slice in their own score units, so theirs is read off the recent replay below.
        callsTopPct: RANK_CUTOFF_ROLES.includes(spec.role) ? callsTopPct(exam?.threshold) : null,
        fromExam: RANK_CUTOFF_ROLES.includes(spec.role),
        examWinRatePct: exam?.winRatePct ?? null,
        examCalls: exam?.support ?? null,
        meetsTargets: exam?.meetsTargets ?? null,
        highTopPct:
          metrics.highConviction && metrics.highConviction.earned !== false
            ? callsTopPct(metrics.highConviction.rank)
            : null,
        sampleCallsPct: null,
      },
      calls: calls.get(spec.id) ?? { lastHour: 0, last24h: 0, last7d: 0, perHour24h: 0, lastAt: null },
      calibration: null,
      agreementCurve: metrics.agreementCurve
        ? metrics.agreementCurve.map((p) => ({
            agreeing: p.agreeing,
            rows: p.rows,
            winRatePct: p.rows > 0 ? Math.round((p.wins / p.rows) * 1000) / 10 : null,
          }))
        : null,
      inputs: null,
      inputSample: null,
      members: null,
      otherSignals: null,
      rule: null,
      rules: metrics.rulesInUse
        ? {
            source: metrics.rulesInUse.source,
            lines: metrics.rulesInUse.lines,
            reason: metrics.rulesInUse.reason,
            teacherName: metrics.rulesInUse.teacher?.name ?? null,
          }
        : null,
    };
    if (params && "calibration" in params && params.calibration) {
      const c = params.calibration;
      seat.calibration = { knots: c.knots, calls: c.calls, windowFrom: c.windowFrom, windowTo: c.windowTo };
    }

    if (isLearnerParams(params)) {
      // The narrative seats decide only on moments that carry TokenSage's deep read.
      const narrative = spec.role === "narrative";
      const acc = accumulator();
      const probs = new Float64Array(sample.length);
      for (let i = 0; i < sample.length; i++) {
        const f = sample[i]!;
        const p = scoreCandidateWithModel(params, f);
        probs[i] = p;
        if (narrative && f.nsDepthFull !== 1) continue;
        addContributions(acc, featureContributions(params, f), p >= params.threshold);
      }
      if (spec.role === "learner") probabilities.set(spec.id, probs);
      seat.inputs = inputWeights(acc, params);
      seat.inputSample = { rows: acc.rows, calls: acc.calls };
      seat.cutoff.sampleCallsPct = acc.rows > 0 ? Math.round((acc.calls / acc.rows) * 1000) / 10 : null;
    } else if (params?.kind === RULES_MODEL_KIND && params.derived && params.rankCutoff !== null) {
      const set = params.derived;
      const cutoff = params.rankCutoff;
      const called = sample.filter((f) => {
        const points = scoreRuleSet(set, f);
        return points > 0 && points >= cutoff;
      }).length;
      seat.inputSample = { rows: sample.length, calls: called };
      seat.cutoff.sampleCallsPct =
        sample.length > 0 ? Math.round((called / sample.length) * 1000) / 10 : null;
    } else if (
      params &&
      (params.kind === AGREEMENT_MODEL_KIND ||
        params.kind === BLEND_MODEL_KIND ||
        params.kind === TOP_SLICE_MODEL_KIND ||
        params.kind === STACKED_MODEL_KIND)
    ) {
      explainCombiner(seat, params, probabilities, sample.length, names);
    }
    if (!seat.cutoff.fromExam) seat.cutoff.callsTopPct = seat.cutoff.sampleCallsPct;
    seats.set(spec.id, seat);
  }

  return {
    builtAt: new Date(),
    defaultModel: state.defaultModel,
    aiReviewMode: env.AI_REVIEW_MODE,
    momentsPerHour: Math.round((moments24h / 24) * 10) / 10,
    sample: {
      rows: sample.length,
      from: sampleRows.at(-1)?.anchorAt ?? null,
      to: sampleRows[0]?.anchorAt ?? null,
      deepReadRows: deepRead.length,
    },
    // Back in roster order.
    seats: state.roster.map((c) => seats.get(c.id)).filter((s): s is SeatExplain => s !== undefined),
  };
}

function explainCombiner(
  seat: SeatExplain,
  params: AgreementCuratorParams | BlendCuratorParams | TopSliceCuratorParams | StackedCuratorParams,
  probabilities: ReadonlyMap<string, Float64Array>,
  rows: number,
  names: ReadonlyMap<string, string>,
) {
  const members: readonly StackedMember[] = params.members;
  seat.rule = combinerRule(params, members.length);
  const meta = params.kind === STACKED_MODEL_KIND ? metaWeights(params) : null;

  // Replay the simple combiners on the sample from the members' own probabilities - the same
  // map the worker builds. The consensus also reads Rules' gate, which the stored inputs can't
  // replay, so it shows its weights only.
  const backing = new Array<number>(members.length).fill(0);
  let called = 0;
  let replayed = false;
  if (params.kind !== STACKED_MODEL_KIND && members.every((m) => probabilities.has(m.contestant))) {
    replayed = true;
    for (let i = 0; i < rows; i++) {
      const map = new Map<string, number>();
      for (const m of members) map.set(m.contestant, probabilities.get(m.contestant)![i]!);
      const score =
        params.kind === AGREEMENT_MODEL_KIND
          ? scoreAgreement(params, map)
          : params.kind === BLEND_MODEL_KIND
            ? scoreBlend(params, map)
            : scoreTopSlice(params, map);
      if (score < params.threshold) continue;
      called += 1;
      members.forEach((m, j) => {
        const rank = rankFromQuantiles(m.quantiles, map.get(m.contestant)!);
        if (memberCalls(m.callRank, rank)) backing[j]! += 1;
      });
    }
    seat.cutoff.sampleCallsPct = rows > 0 ? Math.round((called / rows) * 1000) / 10 : null;
    seat.inputSample = { rows, calls: called };
  }

  seat.members = members.map((m, j) => {
    const w = meta?.get(memberSignalName(m.contestant));
    return {
      contestant: m.contestant,
      name: names.get(m.contestant) ?? m.contestant,
      callsTopPct: callsTopPct(m.callRank),
      weightPct: w?.sharePct ?? null,
      direction: w?.direction ?? null,
      backingPct: replayed && called > 0 ? Math.round((backing[j]! / called) * 1000) / 10 : null,
    };
  });
  if (meta) {
    const labels: [string, string][] = [
      [RULES_RANK_SIGNAL, "Rules' score rank"],
      [RULES_GATE_SIGNAL, "Rules' checks pass"],
      [AGREEMENT_SIGNAL, "Share of members calling"],
    ];
    seat.otherSignals = labels
      .filter(([key]) => meta.has(key))
      .map(([key, label]) => ({
        label,
        weightPct: meta.get(key)!.sharePct,
        direction: meta.get(key)!.direction,
      }));
  }
}

// ---------- One call, explained ----------

export interface CallPush {
  label: string;
  /** Push on the score in log-odds: + toward a call, - away. */
  value: number;
}

export interface CallMember {
  contestant: string;
  name: string;
  /** Its probability for this coin, recomputed. */
  probability: number | null;
  /** Its rank among decision moments, 0-1. */
  rank: number | null;
  /** Its cutoff rank, 0-1; null when it had none. */
  callRank: number | null;
  calling: boolean;
}

export interface CallExplain {
  alert: {
    id: string;
    createdAt: Date;
    model: string | null;
    modelName: string | null;
    source: string;
    confidence: number;
    tier: string | null;
    calibratedPct: number | null;
    reasons: string[];
    symbol: string | null;
    mint: string;
  };
  /** False when the decision moment's inputs are no longer stored (pruned) or the model is gone. */
  recomputed: boolean;
  note: string | null;
  /** The score recomputed now from the stored inputs, 0-100, against the cutoff. */
  score: number | null;
  cutoff: number | null;
  pushesFor: CallPush[];
  pushesAgainst: CallPush[];
  members: CallMember[] | null;
  /** The member whose own reasons are shown, for a combiner call. */
  strongestMember: string | null;
}

const PUSHES = 6;

function pushes(params: TrainedCuratorParams, features: Features): { for: CallPush[]; against: CallPush[] } {
  const byLabel = new Map<string, number>();
  for (const c of featureContributions(params, features)) {
    if (!Number.isFinite(c.value)) continue;
    const label = inputLabel(c.name);
    byLabel.set(label, (byLabel.get(label) ?? 0) + c.value);
  }
  const all = [...byLabel].map(([label, value]) => ({ label, value: Math.round(value * 1000) / 1000 }));
  return {
    for: all
      .filter((p) => p.value >= 0.005)
      .sort((a, b) => b.value - a.value)
      .slice(0, PUSHES),
    against: all
      .filter((p) => p.value <= -0.005)
      .sort((a, b) => a.value - b.value)
      .slice(0, PUSHES),
  };
}

/**
 * Why one call was made: the inputs at its decision moment run back through the exact model that
 * made it (CuratedAlert.source is that model's row id). A learner shows the inputs that pushed
 * its score up and down; a combiner shows each member's rank against its own cutoff, then the
 * strongest member's pushes. Recomputed, not recorded: a call sent on a later look than its
 * decision moment can read slightly differently, and the reply says so when it does.
 */
export async function explainCall(env: Env, alertId: string): Promise<CallExplain | null> {
  const alert = await prisma.curatedAlert.findUnique({
    where: { id: alertId },
    select: {
      id: true,
      createdAt: true,
      model: true,
      modelName: true,
      source: true,
      confidence: true,
      tier: true,
      calibratedPct: true,
      reasons: true,
      token: { select: { mintAddress: true, symbol: true } },
      candidateOutcome: { select: { features: true } },
    },
  });
  if (!alert) return null;
  const out: CallExplain = {
    alert: {
      id: alert.id,
      createdAt: alert.createdAt,
      model: alert.model,
      modelName: alert.modelName,
      source: alert.source,
      confidence: alert.confidence,
      tier: alert.tier,
      calibratedPct: alert.calibratedPct,
      reasons: alert.reasons,
      symbol: alert.token.symbol,
      mint: alert.token.mintAddress,
    },
    recomputed: false,
    note: null,
    score: null,
    cutoff: null,
    pushesFor: [],
    pushesAgainst: [],
    members: null,
    strongestMember: null,
  };
  const features = asFeatures(alert.candidateOutcome?.features);
  if (!features) {
    out.note =
      "This call's decision-moment inputs are no longer stored, so only its recorded reasons remain.";
    return out;
  }
  const params = await loadParams(alert.source);
  if (!params) {
    out.note =
      alert.model === "rules"
        ? "Rules calls are explained by the checks they pass, listed in the reasons."
        : "The model that made this call is no longer stored.";
    return out;
  }
  if (isLearnerParams(params)) {
    const p = scoreCandidateWithModel(params, features);
    const pushed = pushes(params, features);
    Object.assign(out, {
      recomputed: true,
      score: Math.round(p * 1000) / 10,
      cutoff: Math.round(params.threshold * 1000) / 10,
      pushesFor: pushed.for,
      pushesAgainst: pushed.against,
    });
  } else if (
    params.kind === AGREEMENT_MODEL_KIND ||
    params.kind === BLEND_MODEL_KIND ||
    params.kind === TOP_SLICE_MODEL_KIND ||
    params.kind === STACKED_MODEL_KIND
  ) {
    const state = await contestState(env);
    const names = new Map(state.roster.map((c) => [c.id, c.name]));
    const map = new Map<string, number>();
    const memberParams = new Map<string, TrainedCuratorParams>();
    const members: CallMember[] = [];
    for (const m of params.members) {
      const mp = await loadParams(m.modelId);
      const probability = isLearnerParams(mp) ? scoreCandidateWithModel(mp, features) : null;
      if (probability !== null && isLearnerParams(mp)) {
        map.set(m.contestant, probability);
        memberParams.set(m.contestant, mp);
      }
      const rank = probability !== null ? rankFromQuantiles(m.quantiles, probability) : null;
      members.push({
        contestant: m.contestant,
        name: names.get(m.contestant) ?? m.contestant,
        probability: probability !== null ? Math.round(probability * 10000) / 10000 : null,
        rank: rank !== null ? Math.round(rank * 1000) / 1000 : null,
        callRank: m.callRank ?? null,
        calling: rank !== null && memberCalls(m.callRank, rank),
      });
    }
    members.sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1));
    out.members = members;
    out.recomputed = true;
    if (params.kind !== STACKED_MODEL_KIND) {
      const score =
        params.kind === AGREEMENT_MODEL_KIND
          ? scoreAgreement(params, map)
          : params.kind === BLEND_MODEL_KIND
            ? scoreBlend(params, map)
            : scoreTopSlice(params, map);
      out.score = Math.round(score * 1000) / 10;
      out.cutoff = Math.round(params.threshold * 1000) / 10;
    } else {
      out.note =
        "The consensus also reads Rules' checks at the moment, which aren't stored, so its own score isn't recomputed.";
    }
    const strongest = members.find((m) => memberParams.has(m.contestant));
    if (strongest) {
      const pushed = pushes(memberParams.get(strongest.contestant)!, features);
      out.strongestMember = strongest.name;
      out.pushesFor = pushed.for;
      out.pushesAgainst = pushed.against;
    }
  } else {
    out.note = "Rules calls are explained by the checks they pass, listed in the reasons.";
  }
  if (out.score !== null && Math.abs(out.score - alert.confidence) > 1 && out.note === null) {
    out.note = `Recomputed at ${out.score.toFixed(1)} against ${alert.confidence.toFixed(1)} recorded: the coin was called on a later look than its decision moment, so its inputs had moved.`;
  }
  return out;
}

/** A seat's newest calls, for the explainer's call picker. */
export async function recentSeatCalls(model: string, limit: number) {
  const rows = await prisma.curatedAlert.findMany({
    where: { model },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      createdAt: true,
      confidence: true,
      tier: true,
      calibratedPct: true,
      reasons: true,
      hit2xIn1h: true,
      hit4xIn1h: true,
      disqualified: true,
      token: { select: { mintAddress: true, symbol: true } },
      candidateOutcome: { select: { hit2xIn1h: true, hit4xIn1h: true, disqualified: true } },
    },
  });
  return rows.map((r) => {
    const won = r.hit2xIn1h ?? r.candidateOutcome?.hit2xIn1h ?? null;
    const dq = r.disqualified ?? r.candidateOutcome?.disqualified ?? null;
    const goal = r.hit4xIn1h ?? r.candidateOutcome?.hit4xIn1h ?? null;
    return {
      id: r.id,
      createdAt: r.createdAt,
      confidence: r.confidence,
      tier: r.tier,
      calibratedPct: r.calibratedPct,
      reasons: r.reasons,
      symbol: r.token.symbol,
      mint: r.token.mintAddress,
      result: won === null ? "open" : dq ? "stopped" : goal ? "4x" : won ? "2x" : "miss",
    };
  });
}

export type SeatCall = Awaited<ReturnType<typeof recentSeatCalls>>[number];
