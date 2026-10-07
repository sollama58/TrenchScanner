import type { Env } from "../config/env.js";
import { activeModelCutoffs, loadChampion, resolveDefaultModel } from "./champion.js";
import { CONSENSUS_CONTESTANT, enabledContestants, type ContestantSpec } from "./contestants.js";
import { withLanes } from "./evolution.js";
import { loadCurrentLanes } from "./laneStore.js";
import { NEVER_EMIT_THRESHOLD, defaultContestant } from "./trainingRun.js";

/**
 * Which models' calls a user's feed carries. The API's contest state (apps/api/src/contest.ts)
 * and the worker's Telegram dispatcher both have to answer "does this call belong in this
 * person's feed" the same way, so the rule lives here and both read it.
 */

/** The part of the contest state the rule needs: the roster and today's default (best performer). */
export interface FeedModelState {
  roster: readonly ContestantSpec[];
  defaultModel: string;
}

/** What a user saved about their feed: the User columns the feeds read. */
export interface SavedFeedModels {
  /** The single-ledger pick (/curated); kept equal to models[0]. */
  model: string | null;
  /** The combined feed's checked models; empty = follow the default. */
  models: string[];
  /** Follow the best performer (the default) instead of the hand picks above. */
  followBest: boolean;
}

/**
 * The ledgers the combined feed reads, in roster order: the default (the best performer) while the
 * user follows it; else their checked models that are still on the roster, else their single
 * pick, else the default. `followsDefault` is true when the feed is showing the default.
 */
export function resolveFeedModels(
  state: FeedModelState,
  saved: SavedFeedModels,
): { models: string[]; followsDefault: boolean } {
  if (saved.followBest) return { models: [state.defaultModel], followsDefault: true };
  const checked = new Set(saved.models);
  const models = state.roster.filter((c) => checked.has(c.id)).map((c) => c.id);
  if (models.length > 0) return { models, followsDefault: false };
  const single =
    saved.model !== null && state.roster.some((c) => c.id === saved.model) ? saved.model : state.defaultModel;
  return { models: [single], followsDefault: single !== saved.model };
}

/**
 * The roster and the default model as the worker sees them: the same reads the API's
 * contestState makes (lanes, the champion, each contestant's active cutoff), without its cache.
 */
export async function loadFeedModelState(env: Env): Promise<FeedModelState> {
  const [lanes, champion] = await Promise.all([loadCurrentLanes(), loadChampion()]);
  const roster = withLanes(enabledContestants(env.CURATOR_CONTESTANTS), lanes);
  const cutoffs = await activeModelCutoffs(roster.map((c) => c.id));
  const canCall = (id: string) => {
    const spec = roster.find((c) => c.id === id);
    if (!spec) return false;
    if (spec.role === "rules") return true;
    const threshold = cutoffs.get(id)?.threshold;
    return typeof threshold === "number" && threshold < NEVER_EMIT_THRESHOLD;
  };
  const consensusEnabled = roster.some((c) => c.id === CONSENSUS_CONTESTANT);
  return {
    roster,
    defaultModel: resolveDefaultModel(
      champion?.contestant ?? null,
      canCall,
      defaultContestant(consensusEnabled ? cutoffs.get(CONSENSUS_CONTESTANT)?.threshold : null),
    ),
  };
}
