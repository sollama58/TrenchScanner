import { DEFAULT_BOOSTING_OPTIONS, type BoostingOptions } from "./boosting.js";
import { ORDER_FLOW_FEATURES, type ContestantSpec, type CuratorRecipe } from "./contestants.js";
import { CANDIDATE_FEATURE_NAMES, type CandidateFeatureName } from "./features.js";

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
  if (recipe.learner === "gbdt") {
    const boosting: BoostingOptions = {};
    for (const k of TREE_KNOBS) boosting[k] = recipe.boosting?.[k] ?? DEFAULT_BOOSTING_OPTIONS[k];
    return { learner: "gbdt", recencyHalfLifeDays, boosting };
  }
  return {
    learner: "logistic",
    recencyHalfLifeDays,
    ...(recipe.featureNames ? { featureNames: [...recipe.featureNames] } : {}),
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

function mutateFeatures(
  current: readonly string[] | undefined,
  rng: Rng,
): CandidateFeatureName[] | undefined {
  const all = CANDIDATE_FEATURE_NAMES as readonly CandidateFeatureName[];
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
      } else if (rng() < 0.5) {
        child = mate.featureNames
          ? { ...child, featureNames: [...mate.featureNames] }
          : { learner: "logistic", recencyHalfLifeDays: child.recencyHalfLifeDays };
      }
    }
    if (rng() < FAMILY_SWITCH_P) {
      child = normalizeRecipe(
        {
          learner: child.learner === "gbdt" ? "logistic" : "gbdt",
          recencyHalfLifeDays: child.recencyHalfLifeDays,
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
        } else {
          const featureNames = mutateFeatures(child.featureNames, rng);
          child = featureNames
            ? { ...child, featureNames }
            : { learner: "logistic", recencyHalfLifeDays: child.recencyHalfLifeDays };
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

const isOrderFlow = (names: readonly string[]) =>
  names.length === ORDER_FLOW_FEATURES.length &&
  names.every((n) => ORDER_FLOW_FEATURES.includes(n as CandidateFeatureName));

/** The family-and-traits part of a lane's name, e.g. "Deep Trees Recent". */
export function traitName(recipe: CuratorRecipe, baseHalfLifeDays: number): string {
  const r = normalizeRecipe(recipe, baseHalfLifeDays);
  let family: string;
  if (r.learner === "gbdt") {
    const depth = r.boosting!.maxDepth!;
    family = depth >= 5 ? "Deep Trees" : depth <= 2 ? "Shallow Trees" : "Trees";
  } else if (r.featureNames && isOrderFlow(r.featureNames)) {
    family = "Order Flow";
  } else {
    family = r.featureNames ? "Lean Linear" : "Linear";
  }
  const hl = r.recencyHalfLifeDays!;
  const memory = hl <= 4 ? " Recent" : hl >= 30 ? " Patient" : "";
  return family + memory;
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
    what = `Boosted trees, depth ${b.maxDepth}, learning rate ${b.learningRate}, each tree sees ${Math.round(
      b.rowSample! * 100,
    )}% of rows and ${Math.round(b.featureSample! * 100)}% of features; ${memory}`;
  } else {
    const n = r.featureNames?.length ?? CANDIDATE_FEATURE_NAMES.length;
    what = `Logistic regression on ${n === CANDIDATE_FEATURE_NAMES.length ? "every" : `${n} of ${CANDIDATE_FEATURE_NAMES.length}`} features; ${memory}`;
  }
  return parentName ? `${what}. Bred from ${parentName}.` : what;
}

/** The founding lanes: each learner seat's hand-written recipe, under its roster name. */
export function foundingLanes(specs: readonly ContestantSpec[], bornAt: Date): Lane[] {
  return specs
    .filter((s) => s.role === "learner" && s.recipe)
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
    return lane ? { ...s, name: lane.name, description: lane.description, recipe: lane.recipe } : s;
  });
}

/** A lane as selection sees it: its blended leaderboard score, and this run's exam on its own. */
export interface LaneFitness {
  lane: Lane;
  /** Live and exam blended, exactly as the leaderboard ranks it. Null = nothing graded anywhere. */
  composite: number | null;
}

/**
 * Breeds `count` challengers from the strongest lanes. Parents come by tournament from the top
 * half (two drawn, the better one breeds), so the best recipes spread without one lane cloning
 * itself across the field; a cross takes a second top-half parent of the same family. Recipes
 * already on the roster, or already bred this run, are skipped.
 */
export function breedChallengers(
  fitness: readonly LaneFitness[],
  count: number,
  rng: Rng,
  opts: { baseHalfLifeDays: number; nextGeneration: number },
): Challenger[] {
  if (count <= 0 || fitness.length === 0) return [];
  const ranked = [...fitness].sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
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
    const mates = top.filter((f) => f !== parent && f.lane.recipe.learner === parent.lane.recipe.learner);
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
}

export interface Replacement {
  slot: string;
  challenger: number;
  reason: string;
}

/**
 * At most one takeover per run: the weakest seasoned lane (lowest blended score, never-graded
 * lanes weakest of all) gives its seat to the best challenger, when that challenger beat the
 * lane's own exam on this same run - same rows, same folds - by `margin` points. The margin
 * absorbs the best-of-several luck in picking the top challenger.
 */
export function chooseReplacement(input: ReplacementInput): Replacement | null {
  const seasoned = input.lanes.filter((l) => input.now.getTime() - l.lane.bornAt.getTime() >= input.minAgeMs);
  if (seasoned.length === 0) return null;
  const weakest = seasoned.reduce((w, l) => ((l.composite ?? -1) < (w.composite ?? -1) ? l : w));
  let best = -1;
  for (let i = 0; i < input.challengerScores.length; i++) {
    const s = input.challengerScores[i];
    if (s === null || s === undefined) continue;
    if (best === -1 || s > input.challengerScores[best]!) best = i;
  }
  if (best === -1) return null;
  const challengerScore = input.challengerScores[best]!;
  const bar = (weakest.examScore ?? 0) + input.margin;
  if (challengerScore < bar) return null;
  return {
    slot: weakest.lane.slot,
    challenger: best,
    reason:
      `exam ${challengerScore.toFixed(1)} vs ${weakest.lane.name}'s ${weakest.examScore?.toFixed(1) ?? "none"} ` +
      `on the same run (leaderboard ${weakest.composite?.toFixed(1) ?? "unscored"}, weakest of ${seasoned.length} seasoned)`,
  };
}
