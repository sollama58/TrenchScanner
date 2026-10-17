import { DEFAULT_BOOSTING_OPTIONS, type BoostingObjective, type BoostingOptions } from "./boosting.js";
import { DEFAULT_FOREST_OPTIONS, type ForestOptions } from "./forest.js";
import {
  isMemberLearner,
  MOMENTUM_FEATURES,
  ORDER_FLOW_FEATURES,
  type ContestantSpec,
  type CuratorRecipe,
} from "./contestants.js";
import { MARKET_LEARNER_FEATURE_NAMES, learnerSubset, type CandidateFeatureName } from "./features.js";
import { MIN_LIVE_CALLS_TO_RANK } from "./leaderboard.js";
import type { SeatGoal } from "./trainer.js";

/**
 * The curator contest, evolving. Every learner seat on the roster (contestants.ts) is a LANE: a
 * stable ledger id (CuratedAlert.model, the id a subscriber picks) holding one recipe at a time.
 * Each training run also breeds a few challengers - mutated (sometimes crossed) copies of the
 * best lanes' recipes - and sits them in the very same walk-forward exam. When the best challenger
 * clearly out-examines the weakest seasoned lane, it takes that lane over: new recipe, new name,
 * a fresh live record. Selection pressure toward what earns hit rate, with the field kept the same
 * size, so memory and run time stay flat.
 *
 * Pure: no IO, randomness only through the rng passed in. The training job decides with these
 * and stores lanes in CuratorLane.
 */

export interface Lane {
  /** The roster seat (a learner contestant id) - the ledger its calls are recorded under. */
  slot: string;
  /** What the leaderboard and the model picker show while this recipe holds the seat. */
  name: string;
  description: string;
  recipe: CuratorRecipe;
  /** 0 for the founding recipes; otherwise a run-wide counter, so every bred name is unique. */
  generation: number;
  parentName: string | null;
  bornAt: Date;
}

/** A bred recipe waiting for its exam. */
export interface Challenger {
  recipe: CuratorRecipe;
  name: string;
  description: string;
  generation: number;
  parentName: string;
}

export type Rng = () => number;

/** mulberry32: small, fast, deterministic for a given seed - runs are reproducible from the log. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const roundTo = (v: number, step: number) => Math.round(v / step) * step;

/** The search space. Bounds keep every offspring trainable inside the worker's time and memory. */
const HALF_LIFE_DAYS = { min: 1, max: 60 };
const TREE_BOUNDS = {
  maxDepth: { min: 2, max: 6 },
  minLeafRows: { min: 15, max: 200 },
  learningRate: { min: 0.02, max: 0.2 },
  l2: { min: 0.1, max: 10 },
  rowSample: { min: 0.4, max: 1 },
  featureSample: { min: 0.4, max: 1 },
  maxTrees: { min: 100, max: 400 },
};
const FOREST_BOUNDS = {
  trees: { min: 30, max: 120 },
  maxDepth: { min: 4, max: 9 },
  minLeafRows: { min: 10, max: 100 },
  featureSample: { min: 0.15, max: 0.6 },
};
type ForestKnob = keyof typeof FOREST_BOUNDS;
const FOREST_KNOBS = Object.keys(FOREST_BOUNDS) as ForestKnob[];
/** A linear lane never reads fewer features than this. */
const MIN_FEATURES = 8;
/** Chance a mutation jumps to the other model family (with that family's default knobs). */
const FAMILY_SWITCH_P = 0.1;
/** Chance a challenger is a cross of two top lanes of the same family rather than one parent's copy. */
const CROSSOVER_P = 0.3;

type TreeKnob = keyof typeof TREE_BOUNDS;
const TREE_KNOBS = Object.keys(TREE_BOUNDS) as TreeKnob[];

/** A recipe with every knob the mutator touches written out, so offspring differ by explicit steps. */
export function normalizeRecipe(recipe: CuratorRecipe, baseHalfLifeDays: number): CuratorRecipe {
  const recencyHalfLifeDays = recipe.recencyHalfLifeDays ?? baseHalfLifeDays;
  // The two-stage shape is inherited, never mutated: it is a different question (survive, then
  // run), and a seat that holds it keeps asking it.
  // The goal is inherited the same way: what the seat is trained and examined on (SeatGoal).
  const shape = {
    ...(recipe.twoStage ? { twoStage: true as const } : {}),
    ...(recipe.goal !== undefined ? { goal: recipe.goal } : {}),
  };
  if (recipe.learner === "gbdt") {
    const boosting: BoostingOptions = {};
    for (const k of TREE_KNOBS) boosting[k] = recipe.boosting?.[k] ?? DEFAULT_BOOSTING_OPTIONS[k];
    // The objective is inherited, never mutated: what the trees fit is the seat's question.
    const objective = recipe.boosting?.objective;
    if (objective !== undefined && objective !== "logistic") boosting.objective = objective;
    return { learner: "gbdt", recencyHalfLifeDays, boosting, ...shape };
  }
  if (recipe.learner === "forest") {
    const forest: ForestOptions = {};
    for (const k of FOREST_KNOBS) forest[k] = recipe.forest?.[k] ?? DEFAULT_FOREST_OPTIONS[k];
    return { learner: "forest", recencyHalfLifeDays, forest, ...shape };
  }
  // A lineage bred before an input was retired still lists it, and a recipe's list is read as
  // is at training time; the retired names leave here, so no child, mate or stored challenger
  // carries them on. So do the TokenSage inputs the market seats no longer read
  // (MARKET_TOKENSAGE_INPUTS). A list that was only those names means every market input.
  const market = new Set<string>(MARKET_LEARNER_FEATURE_NAMES);
  const featureNames = recipe.featureNames
    ? learnerSubset(recipe.featureNames).filter((name) => market.has(name))
    : undefined;
  return {
    learner: "logistic",
    recencyHalfLifeDays,
    ...(featureNames && featureNames.length > 0 ? { featureNames } : {}),
    ...shape,
  };
}

function mutateTreeKnob(boosting: BoostingOptions, knob: TreeKnob, rng: Rng): void {
  const b = TREE_BOUNDS[knob];
  const cur = boosting[knob] ?? DEFAULT_BOOSTING_OPTIONS[knob];
  let next: number;
  switch (knob) {
    case "maxDepth":
      next = cur + (rng() < 0.5 ? -1 : 1);
      break;
    case "minLeafRows":
    case "maxTrees":
      next = Math.round(cur * Math.exp(0.4 * gaussian(rng)));
      break;
    case "learningRate":
      next = roundTo(cur * Math.exp(0.3 * gaussian(rng)), 0.005);
      break;
    case "l2":
      next = roundTo(cur * Math.exp(0.5 * gaussian(rng)), 0.1);
      break;
    default:
      next = roundTo(cur + 0.1 * gaussian(rng), 0.05);
  }
  boosting[knob] = clamp(next, b.min, b.max);
}

function mutateForestKnob(forest: ForestOptions, knob: ForestKnob, rng: Rng): void {
  const b = FOREST_BOUNDS[knob];
  const cur = forest[knob] ?? DEFAULT_FOREST_OPTIONS[knob];
  let next: number;
  switch (knob) {
    case "maxDepth":
      next = cur + (rng() < 0.5 ? -1 : 1);
      break;
    case "featureSample":
      next = roundTo(cur + 0.1 * gaussian(rng), 0.05);
      break;
    default:
      next = Math.round(cur * Math.exp(0.4 * gaussian(rng)));
  }
  forest[knob] = clamp(next, b.min, b.max);
}

function mutateFeatures(
  current: readonly string[] | undefined,
  rng: Rng,
): CandidateFeatureName[] | undefined {
  const all = MARKET_LEARNER_FEATURE_NAMES;
  const have = new Set<CandidateFeatureName>((current as CandidateFeatureName[] | undefined) ?? all);
  const missing = all.filter((f) => !have.has(f));
  const steps = 1 + Math.floor(rng() * 3);
  const drop = missing.length === 0 || (have.size > MIN_FEATURES + steps && rng() < 0.5);
  for (let i = 0; i < steps; i++) {
    if (drop) {
      if (have.size <= MIN_FEATURES) break;
      const list = [...have];
      have.delete(list[Math.floor(rng() * list.length)]!);
    } else {
      const pool = all.filter((f) => !have.has(f));
      if (pool.length === 0) break;
      have.add(pool[Math.floor(rng() * pool.length)]!);
    }
  }
  // Every feature back in is the same as no subset - stored that way so names read "Linear".
  return have.size === all.length ? undefined : all.filter((f) => have.has(f));
}

/**
 * One offspring: the parent's recipe with one or two knobs stepped (or, rarely, the other family
 * at its defaults), crossed knob by knob with `mate` first when one is given. Never returns a
 * recipe equal to the parent's.
 */
export function mutateRecipe(
  parent: CuratorRecipe,
  rng: Rng,
  opts: { baseHalfLifeDays: number; mate?: CuratorRecipe },
): CuratorRecipe {
  const base = normalizeRecipe(parent, opts.baseHalfLifeDays);
  const before = JSON.stringify(base);
  for (let attempt = 0; attempt < 8; attempt++) {
    let child = normalizeRecipe(base, opts.baseHalfLifeDays);
    if (opts.mate && opts.mate.learner === child.learner) {
      const mate = normalizeRecipe(opts.mate, opts.baseHalfLifeDays);
      if (rng() < 0.5) child.recencyHalfLifeDays = mate.recencyHalfLifeDays;
      if (child.learner === "gbdt") {
        for (const k of TREE_KNOBS) if (rng() < 0.5) child.boosting![k] = mate.boosting![k];
      } else if (child.learner === "forest") {
        for (const k of FOREST_KNOBS) if (rng() < 0.5) child.forest![k] = mate.forest![k];
      } else if (rng() < 0.5) {
        child = mate.featureNames
          ? { ...child, featureNames: [...mate.featureNames] }
          : normalizeRecipe(
              {
                learner: "logistic",
                recencyHalfLifeDays: child.recencyHalfLifeDays,
                twoStage: child.twoStage,
                goal: child.goal,
              },
              opts.baseHalfLifeDays,
            );
      }
    }
    // A forest stays a forest: it is its own family, with no near neighbour to jump to.
    if (child.learner !== "forest" && rng() < FAMILY_SWITCH_P) {
      child = normalizeRecipe(
        {
          learner: child.learner === "gbdt" ? "logistic" : "gbdt",
          recencyHalfLifeDays: child.recencyHalfLifeDays,
          twoStage: child.twoStage,
          goal: child.goal,
        },
        opts.baseHalfLifeDays,
      );
    } else {
      const steps = 1 + (rng() < 0.4 ? 1 : 0);
      for (let s = 0; s < steps; s++) {
        if (rng() < 0.3) {
          child.recencyHalfLifeDays = clamp(
            roundTo(child.recencyHalfLifeDays! * Math.exp(0.5 * gaussian(rng)), 0.5),
            HALF_LIFE_DAYS.min,
            HALF_LIFE_DAYS.max,
          );
        } else if (child.learner === "gbdt") {
          mutateTreeKnob(child.boosting!, TREE_KNOBS[Math.floor(rng() * TREE_KNOBS.length)]!, rng);
        } else if (child.learner === "forest") {
          mutateForestKnob(child.forest!, FOREST_KNOBS[Math.floor(rng() * FOREST_KNOBS.length)]!, rng);
        } else {
          const featureNames = mutateFeatures(child.featureNames, rng);
          child = featureNames
            ? { ...child, featureNames }
            : normalizeRecipe(
                {
                  learner: "logistic",
                  recencyHalfLifeDays: child.recencyHalfLifeDays,
                  twoStage: child.twoStage,
                  goal: child.goal,
                },
                opts.baseHalfLifeDays,
              );
        }
      }
    }
    if (JSON.stringify(child) !== before) return child;
  }
  // Every step happened to land back on the parent (a clamp at a bound, say): force a visible step.
  const forced = normalizeRecipe(base, opts.baseHalfLifeDays);
  forced.recencyHalfLifeDays =
    forced.recencyHalfLifeDays! >= HALF_LIFE_DAYS.max
      ? HALF_LIFE_DAYS.max / 2
      : forced.recencyHalfLifeDays! + 1;
  return forced;
}

const sameSet = (names: readonly string[], set: readonly CandidateFeatureName[]) =>
  names.length === set.length && names.every((n) => set.includes(n as CandidateFeatureName));
const isOrderFlow = (names: readonly string[]) => sameSet(names, ORDER_FLOW_FEATURES);
const isMomentum = (names: readonly string[]) => sameSet(names, MOMENTUM_FEATURES);

/** The goal part of a bred lane's name, so an evolved seat still says what it trains for. */
const GOAL_NAMES: Record<SeatGoal, string> = {
  "2x": "2x",
  "4x": "4x",
  "10x": "10x",
  return: "Return",
  safe: "Safe",
  moonshot: "Moonshot",
  catch: "Catcher",
};

/** The goal-family-and-traits part of a lane's name, e.g. "Return Deep Trees Recent". */
export function traitName(recipe: CuratorRecipe, baseHalfLifeDays: number): string {
  const r = normalizeRecipe(recipe, baseHalfLifeDays);
  let family: string;
  if (r.learner === "gbdt") {
    const depth = r.boosting!.maxDepth!;
    family = depth >= 5 ? "Deep Trees" : depth <= 2 ? "Shallow Trees" : "Trees";
    const objective = r.boosting!.objective;
    if (objective === "lambdarank") family = `Ranked ${family}`;
    else if (objective === "runSize" && r.goal !== "moonshot") family = `Runner ${family}`;
    else if (objective === "return") family = `Regression ${family}`;
  } else if (r.learner === "forest") {
    const depth = r.forest!.maxDepth!;
    family = depth >= 8 ? "Deep Forest" : "Forest";
  } else if (r.featureNames && isOrderFlow(r.featureNames)) {
    family = "Order Flow";
  } else if (r.featureNames && isMomentum(r.featureNames)) {
    family = "Momentum";
  } else {
    family = r.featureNames ? "Lean Linear" : "Linear";
  }
  const hl = r.recencyHalfLifeDays!;
  const memory = hl <= 4 ? " Recent" : hl >= 30 ? " Patient" : "";
  return (r.goal ? `${GOAL_NAMES[r.goal]} ` : "") + (r.twoStage ? "Survivor " : "") + family + memory;
}

const fmtDays = (d: number) => `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? "" : "s"}`;

/** One plain line on what the recipe is - shown under the name on the leaderboard. */
export function describeRecipe(
  recipe: CuratorRecipe,
  baseHalfLifeDays: number,
  parentName?: string | null,
): string {
  const r = normalizeRecipe(recipe, baseHalfLifeDays);
  const memory = `older data counts half after ${fmtDays(r.recencyHalfLifeDays!)}`;
  let what: string;
  if (r.learner === "gbdt") {
    const b = r.boosting!;
    const fitted =
      b.objective === "lambdarank"
        ? "Boosted trees fitted to each hour's order by run size"
        : b.objective === "runSize"
          ? "Boosted trees fitted to the run size"
          : b.objective === "return"
            ? "Boosted trees fitted to the return under the exit plan"
            : "Boosted trees";
    what = `${fitted}, depth ${b.maxDepth}, learning rate ${b.learningRate}, each tree sees ${Math.round(
      b.rowSample! * 100,
    )}% of rows and ${Math.round(b.featureSample! * 100)}% of features; ${memory}`;
  } else if (r.learner === "forest") {
    const f = r.forest!;
    what = `Random forest of ${f.trees} trees, depth ${f.maxDepth}, at least ${f.minLeafRows} rows a leaf, each tree sees ${Math.round(
      f.featureSample! * 100,
    )}% of features; ${memory}`;
  } else {
    const n = r.featureNames?.length ?? MARKET_LEARNER_FEATURE_NAMES.length;
    what = `Logistic regression on ${n === MARKET_LEARNER_FEATURE_NAMES.length ? "every" : `${n} of ${MARKET_LEARNER_FEATURE_NAMES.length}`} features; ${memory}`;
  }
  if (r.twoStage)
    what = `Two stages (dodge the stop, then double): ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
  return parentName ? `${what}. Bred from ${parentName}.` : what;
}

/**
 * A bred recipe in plain words, for the front leaderboard: what it reads and how, with no knob
 * values (those are in `describeRecipe`, under the hood). A recipe without its own memory length
 * trains on the run's default, so it says nothing about memory.
 */
export function plainSummary(recipe: CuratorRecipe, parentName?: string | null): string {
  let what: string;
  if (recipe.learner === "gbdt" && recipe.boosting?.objective === "lambdarank") {
    what = "Learns to put each hour's biggest runners at the top of the list";
  } else if (recipe.learner === "gbdt" && recipe.boosting?.objective === "runSize") {
    what = "Predicts how big the run will be rather than whether it doubles";
  } else if (recipe.learner === "gbdt" && recipe.boosting?.objective === "return") {
    what = "Predicts how much a call will make under the exit plan, rather than whether it doubles";
  } else if (recipe.learner === "gbdt") {
    const depth = recipe.boosting?.maxDepth ?? DEFAULT_BOOSTING_OPTIONS.maxDepth;
    what =
      depth >= 5
        ? "Learns long if-then chains from every signal"
        : depth <= 2
          ? "Learns short if-then rules from every signal"
          : "Learns if-then rules from every signal";
  } else if (recipe.learner === "forest") {
    const trees = recipe.forest?.trees ?? DEFAULT_FOREST_OPTIONS.trees;
    what = `${trees} independent if-then trees, each shown a different slice of the data, voting together`;
  } else if (recipe.featureNames && isOrderFlow(recipe.featureNames)) {
    what = "Weighs only the last few minutes of trading in one simple formula";
  } else if (recipe.featureNames && isMomentum(recipe.featureNames)) {
    what = "Weighs the last half hour's price path, trading and market mood in one simple formula";
  } else if (recipe.featureNames) {
    what = `Weighs ${recipe.featureNames.length} chosen signals in one simple formula`;
  } else {
    what = "Weighs every signal in one simple formula";
  }
  const hl = recipe.recencyHalfLifeDays;
  if (hl != null && hl <= 4) what += ", mostly remembering the last few days";
  else if (hl != null && hl >= 30) what += ", with a long memory";
  if (recipe.twoStage)
    what = `Asks first whether it avoids a 50% drop, then: ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
  return parentName ? `${what}. A variant bred from ${parentName}.` : `${what}.`;
}

/** The founding lanes: each learner seat's hand-written recipe, under its roster name. */
export function foundingLanes(specs: readonly ContestantSpec[], bornAt: Date): Lane[] {
  return specs
    .filter((s) => isMemberLearner(s) && s.recipe)
    .map((s) => ({
      slot: s.id,
      name: s.name,
      description: s.description,
      recipe: s.recipe!,
      generation: 0,
      parentName: null,
      bornAt,
    }));
}

/**
 * The roster as it stands: each learner seat shows and trains its current lane's recipe under the
 * lane's name. Seats without a lane (never evolved, or the table is empty) keep their founding spec.
 */
export function withLanes(specs: readonly ContestantSpec[], lanes: readonly Lane[]): ContestantSpec[] {
  const bySlot = new Map(lanes.map((l) => [l.slot, l]));
  return specs.map((s) => {
    const lane = s.role === "learner" ? bySlot.get(s.id) : undefined;
    // A founding lane IS the roster spec: it follows the code (a new input added to Order Flow
    // reaches it) rather than the copy stored when it was seated.
    if (!lane || lane.generation === 0) return s;
    return {
      ...s,
      name: goalNamed(lane),
      description: lane.description,
      summary: plainSummary(lane.recipe, lane.parentName),
      recipe: lane.recipe,
    };
  });
}

/**
 * A lane's name with its goal in front (GOAL_NAMES): lanes bred before goals existed (2026-10-17)
 * were stored as "Deep Trees #3", and keep that name in the table; they show as "Return Deep
 * Trees #3". A name that already starts with its goal is left as it is.
 */
export function goalNamed(lane: Pick<Lane, "name" | "recipe">): string {
  const goal = lane.recipe.goal;
  if (goal === undefined) return lane.name;
  const prefix = GOAL_NAMES[goal];
  return lane.name.startsWith(`${prefix} `) ? lane.name : `${prefix} ${lane.name}`;
}

/** A lane as selection sees it: its blended leaderboard score, and this run's exam on its own. */
export interface LaneFitness {
  lane: Lane;
  /** Live and exam blended, exactly as the leaderboard ranks it. Null = nothing graded anywhere. */
  composite: number | null;
  /**
   * Graded live calls behind the composite. Omitted = unknown, treated as seasoned. A lane under
   * MIN_LIVE_CALLS_TO_RANK is warming up: its composite is mostly its exam, and a seat that just
   * took over holds the exam that won it - the best of that run's challengers, which is the
   * optimistic draw by construction. The leaderboard ranks such seats behind the seasoned ones for
   * exactly that reason, and breeding ranks parents the same way.
   */
  liveGraded?: number;
}

/** Breeding order: seasoned lanes before warming-up ones, then by composite - the leaderboard's. */
function rankForBreeding(fitness: readonly LaneFitness[]): LaneFitness[] {
  const warming = (f: LaneFitness) =>
    f.liveGraded !== undefined && f.liveGraded < MIN_LIVE_CALLS_TO_RANK ? 1 : 0;
  return [...fitness].sort((a, b) => warming(a) - warming(b) || (b.composite ?? -1) - (a.composite ?? -1));
}

/**
 * Breeds `count` challengers from the strongest lanes. Parents come by tournament from the top
 * half (two drawn, the better one breeds), so the best recipes spread without one lane cloning
 * itself across the field; a cross takes a second top-half parent of the same family. Recipes
 * already on the roster, or already bred this run, are skipped. "Strongest" is the leaderboard's
 * order (rankForBreeding): a seat still warming up on its exam alone can't be the parent of
 * choice until live calls have backed that exam.
 */
export function breedChallengers(
  fitness: readonly LaneFitness[],
  count: number,
  rng: Rng,
  opts: { baseHalfLifeDays: number; nextGeneration: number },
): Challenger[] {
  if (count <= 0 || fitness.length === 0) return [];
  const ranked = rankForBreeding(fitness);
  const top = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
  const draw = () => top[Math.floor(rng() * top.length)]!;
  const seen = new Set(
    fitness.map((f) => JSON.stringify(normalizeRecipe(f.lane.recipe, opts.baseHalfLifeDays))),
  );
  const out: Challenger[] = [];
  let generation = opts.nextGeneration;
  for (let tries = 0; out.length < count && tries < count * 10; tries++) {
    const a = draw();
    const b = draw();
    const parent = (a.composite ?? -1) >= (b.composite ?? -1) ? a : b;
    const mates = top.filter(
      (f) => f !== parent && recipeFamily(f.lane.recipe) === recipeFamily(parent.lane.recipe),
    );
    const mate =
      mates.length > 0 && rng() < CROSSOVER_P ? mates[Math.floor(rng() * mates.length)]! : undefined;
    const recipe = mutateRecipe(parent.lane.recipe, rng, {
      baseHalfLifeDays: opts.baseHalfLifeDays,
      mate: mate?.lane.recipe,
    });
    const key = JSON.stringify(recipe);
    if (seen.has(key)) continue;
    seen.add(key);
    const parentName = mate ? `${parent.lane.name} × ${mate.lane.name}` : parent.lane.name;
    out.push({
      recipe,
      name: `${traitName(recipe, opts.baseHalfLifeDays)} #${generation}`,
      description: describeRecipe(recipe, opts.baseHalfLifeDays, parentName),
      generation,
      parentName,
    });
    generation++;
  }
  return out;
}

export interface ReplacementInput {
  /** Every evolving lane, with its blended score and THIS run's exam score. */
  lanes: readonly (LaneFitness & { examScore: number | null })[];
  /** This run's exam score per challenger, in breeding order. */
  challengerScores: readonly (number | null)[];
  now: Date;
  /** A lane younger than this keeps its seat: it hasn't had a fair shot at a live record yet. */
  minAgeMs: number;
  /** Points a challenger's exam must beat the weakest lane's same-run exam by. */
  margin: number;
  /**
   * Each challenger's model family (recipeFamily), in breeding order. When given, a family's
   * last seat is never handed to another family: the consensus learns from disagreement, and a
   * field that has collapsed onto one family has no fallback when the market shifts under it.
   */
  challengerLearners?: readonly string[];
  /**
   * Each challenger's goal (CuratorRecipe.goal, unset = "2x"), in breeding order. When given, a
   * challenger only takes a seat with the same goal: a seat keeps what it is trained and judged on
   * (SeatGoal), and a Moonshot child never lands in a Return seat or the other way round.
   */
  challengerGoals?: readonly (SeatGoal | undefined)[];
  /**
   * The statistical gate on a takeover, when given (see TakeoverEvidence). Without it the margin
   * alone decides, as before.
   */
  evidence?: TakeoverEvidence;
}

/**
 * What makes a challenger's exam win EVIDENCE rather than a point estimate. The bootstrap bar
 * rises with the number of challengers (selectionAdjustedConfidence), absorbing best-of-several
 * luck; it and the wins floor absorb the exam's own noise: an exam of 12
 * calls can swing 20 points on two coin flips, so a lane is only unseated when the challenger's
 * exam has enough wins behind it and its 2x rate beats the lane's, at an equal share of the same
 * rows, in most paired bootstrap resamples - and never twice in quick succession, so a seat is
 * not churned run after run on the same thin evidence. The 2x rate alone, with no catch part
 * (user decision 2026-10-14): a takeover is judged the way the Default is picked.
 */
export interface TakeoverEvidence {
  /** Wins the challenger's exam record must hold (a hit rate over three wins is noise). */
  minExamWins: number;
  /** Share of paired bootstrap resamples in which the challenger's 2x rate must be higher (0 = off). */
  confidence: number;
  /**
   * The paired bootstrap confidence that challenger `index` beats lane `slot` on the 2x rate, both
   * calling an equal share of the same rows (pairedBootstrapConfidence), or null when
   * unmeasurable. `required` is the bar it will be held to (selectionAdjustedConfidence), so the
   * caller can draw enough resamples to resolve it (bootstrapDrawsFor).
   */
  pairedConfidence: (slot: string, challenger: number, required: number) => number | null;
  /** Wins in each challenger's exam record, in breeding order. */
  challengerExamWins: readonly number[];
  /** When the newest takeover happened, if any. */
  lastTakeoverAt: Date | null;
  /** A takeover sooner than this after the last one is refused. */
  minTakeoverIntervalMs: number;
}

/**
 * The family a recipe belongs to for the seat guard: its learner, and for boosted trees what
 * they fit - a ranker and a probability model share code but ask different questions, and the
 * field should keep one of each. A two-stage recipe (Survivor) asks its own question too, so it
 * is a family of its own and its last seat is never handed to a one-stage child.
 */
export function recipeFamily(recipe: CuratorRecipe): string {
  const objective: BoostingObjective | undefined = recipe.boosting?.objective;
  const base =
    recipe.learner === "gbdt" && objective !== undefined && objective !== "logistic"
      ? `gbdt:${objective}`
      : recipe.learner;
  return recipe.twoStage ? `${base}:twoStage` : base;
}

/** Paired bootstrap resamples. 200 resolves a 0.9 confidence to about +/-0.02. */
const BOOTSTRAP_DRAWS = 200;

/**
 * The bootstrap bar for the best of `contenders` challengers. The takeover candidate is the one
 * that scored highest on these very exam rows, so with ten in the field one of them looks ahead
 * of a lane by luck far more often than a lone challenger would. Holding each of the k to
 * confidence^(1/k) (Sidak) keeps the chance that ANY of them passes on luck alone where a single
 * challenger at `confidence` would be: 0.9 alone, 0.949 for 2, 0.990 for 10.
 */
export function selectionAdjustedConfidence(confidence: number, contenders: number): number {
  if (confidence <= 0 || contenders <= 1) return confidence;
  return confidence ** (1 / contenders);
}

/** Enough resamples that the bar sits ~20 resamples from 100%: 200 at 0.9, 2,000 at 0.99. */
export function bootstrapDrawsFor(required: number): number {
  if (!(required > 0) || required >= 1) return BOOTSTRAP_DRAWS;
  return Math.min(5_000, Math.max(BOOTSTRAP_DRAWS, Math.ceil(20 / (1 - required) - 1e-9)));
}

/** A decision moment as equalShareCalls needs it: whose it is and when, for the cooldown. */
export interface ShareMoment {
  tokenId?: string;
  anchorMs: number;
}

/**
 * The `k` moments a model ranks highest, as a call mask over `moments`: walked from the highest
 * score down, a moment is skipped when the same token already holds a call within `cooldownMs` of
 * it (either side), so one token's run of high scores is one call, as the per-token cooldown makes
 * it live. Fewer than k only when the cooldown leaves fewer. Two models given the same moments and
 * the same k call the same share of them, so their 2x rates compare at equal volume (user decision
 * 2026-10-14: a takeover is judged on the 2x rate at equal share, not on how many runners a wider
 * cutoff happens to sweep up).
 */
export function equalShareCalls(
  scores: ArrayLike<number>,
  moments: readonly ShareMoment[],
  k: number,
  cooldownMs: number,
): Uint8Array {
  const n = scores.length;
  const mask = new Uint8Array(n);
  if (moments.length !== n || k <= 0) return mask;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b]! - scores[a]! || a - b);
  const sent = new Map<string, number[]>();
  let taken = 0;
  for (const i of order) {
    if (taken >= k) break;
    const { tokenId, anchorMs } = moments[i]!;
    if (tokenId !== undefined) {
      const times = sent.get(tokenId) ?? [];
      if (times.some((t) => Math.abs(t - anchorMs) < cooldownMs)) continue;
      times.push(anchorMs);
      sent.set(tokenId, times);
    }
    mask[i] = 1;
    taken += 1;
  }
  return mask;
}

/**
 * The share of bootstrap resamples (rows drawn with replacement, the SAME draw for both sides)
 * in which the challenger's average value per call is higher than the lane's. `values` is each
 * row's worth toward the seat's goal (goalValue in trainer.ts: 1/0 for a hit-rate goal, the return
 * for "return", and so on), so for the 2x goal this is the 2x rate (user decision 2026-10-14) and
 * for the others the seat's own goal (user ask 2026-10-17: "trained and examined on different
 * goals"). Both sides are given as their call masks over the same rows - "would it have called
 * row i" - so the comparison is paired: both see the same lucky and unlucky rows in every
 * resample. The masks should call an equal share of the rows (equalShareCalls), so a side that
 * calls more rows is not credited for the runners it sweeps up. Null when either side called
 * nothing (no record to compare).
 */
export function pairedBootstrapConfidence(
  values: ArrayLike<number>,
  challengerCalls: ArrayLike<number>,
  laneCalls: ArrayLike<number>,
  rng: Rng,
  draws = BOOTSTRAP_DRAWS,
): number | null {
  const n = values.length;
  if (n === 0 || challengerCalls.length !== n || laneCalls.length !== n) return null;
  let anyChallenger = false;
  let anyLane = false;
  for (let i = 0; i < n; i++) {
    if (challengerCalls[i]) anyChallenger = true;
    if (laneCalls[i]) anyLane = true;
  }
  if (!anyChallenger || !anyLane) return null;
  const rate = (wins: number, calls: number) => (calls === 0 ? 0 : wins / calls);
  let challengerWins = 0;
  for (let d = 0; d < draws; d++) {
    let cCalls = 0;
    let cWins = 0;
    let lCalls = 0;
    let lWins = 0;
    for (let k = 0; k < n; k++) {
      const i = Math.floor(rng() * n);
      const win = values[i]!;
      if (challengerCalls[i]) {
        cCalls += 1;
        cWins += win;
      }
      if (laneCalls[i]) {
        lCalls += 1;
        lWins += win;
      }
    }
    if (rate(cWins, cCalls) > rate(lWins, lCalls)) challengerWins += 1;
  }
  return challengerWins / draws;
}

export interface Replacement {
  slot: string;
  challenger: number;
  reason: string;
}

/**
 * At most one takeover per run: the weakest seasoned lane (lowest blended score, never-graded
 * lanes weakest of all) gives its seat to the best challenger, when that challenger beat the
 * lane's own exam on this same run - same rows, same folds - by `margin` points, and (with
 * evidence) clears a bootstrap bar raised for the number of challengers it was picked from. With challengerLearners, every
 * model family keeps at least one seat (see ReplacementInput.challengerLearners); with
 * challengerGoals, only a seat of the challenger's own goal is open to it.
 */
export function chooseReplacement(input: ReplacementInput): Replacement | null {
  let best = -1;
  let contenders = 0;
  for (let i = 0; i < input.challengerScores.length; i++) {
    const s = input.challengerScores[i];
    if (s === null || s === undefined) continue;
    contenders++;
    if (best === -1 || s > input.challengerScores[best]!) best = i;
  }
  if (best === -1) return null;
  const family = input.challengerLearners?.[best];
  const goal = input.challengerGoals ? (input.challengerGoals[best] ?? "2x") : undefined;
  const familySeats = new Map<string, number>();
  for (const l of input.lanes) {
    const f = recipeFamily(l.lane.recipe);
    familySeats.set(f, (familySeats.get(f) ?? 0) + 1);
  }
  const seasoned = input.lanes.filter(
    (l) =>
      input.now.getTime() - l.lane.bornAt.getTime() >= input.minAgeMs &&
      (goal === undefined || (l.lane.recipe.goal ?? "2x") === goal) &&
      (family === undefined ||
        recipeFamily(l.lane.recipe) === family ||
        familySeats.get(recipeFamily(l.lane.recipe))! > 1),
  );
  if (seasoned.length === 0) return null;
  const weakest = seasoned.reduce((w, l) => ((l.composite ?? -1) < (w.composite ?? -1) ? l : w));
  const challengerScore = input.challengerScores[best]!;
  const bar = (weakest.examScore ?? 0) + input.margin;
  if (challengerScore < bar) return null;
  let evidenceNote = "";
  const ev = input.evidence;
  if (ev) {
    if (
      ev.lastTakeoverAt !== null &&
      input.now.getTime() - ev.lastTakeoverAt.getTime() < ev.minTakeoverIntervalMs
    )
      return null;
    const wins = ev.challengerExamWins[best] ?? 0;
    if (wins < ev.minExamWins) return null;
    if (ev.confidence > 0) {
      const required = selectionAdjustedConfidence(ev.confidence, contenders);
      const confidence = ev.pairedConfidence(weakest.lane.slot, best, required);
      // A lane with no exam record of its own to pair against is beaten by the wins floor alone.
      if (confidence !== null && confidence < required) return null;
      evidenceNote =
        confidence === null
          ? `, ${wins} exam wins`
          : `, ${wins} exam wins, ahead in ${(confidence * 100).toFixed(1)}% of paired resamples ` +
            `(bar ${(required * 100).toFixed(1)}% for the best of ${contenders})`;
    } else {
      evidenceNote = `, ${wins} exam wins`;
    }
  }
  return {
    slot: weakest.lane.slot,
    challenger: best,
    reason:
      `exam ${challengerScore.toFixed(1)} vs ${weakest.lane.name}'s ${weakest.examScore?.toFixed(1) ?? "none"} ` +
      `on the same run (leaderboard ${weakest.composite?.toFixed(1) ?? "unscored"}, weakest of ${seasoned.length} seasoned${evidenceNote})`,
  };
}
