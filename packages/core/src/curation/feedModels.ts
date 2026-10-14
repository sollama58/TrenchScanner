import type { Env } from "../config/env.js";
import { activeModelCutoffs, curatedTargets, loadChampion, resolveDefaultModel } from "./champion.js";
import { CONSENSUS_CONTESTANT, enabledContestants, type ContestantSpec } from "./contestants.js";
import { withLanes } from "./evolution.js";
import { loadCurrentLanes } from "./laneStore.js";
import { loadTopModels } from "./topModels.js";
import { NEVER_EMIT_THRESHOLD, defaultContestant } from "./trainingRun.js";

/**
 * Which models' calls a user's feed carries. The API's contest state (apps/api/src/contest.ts)
 * and the worker's Telegram dispatcher both have to answer "does this call belong in this
 * person's feed" the same way, so the rule lives here and both read it.
 */

/** The part of the contest state the rule needs: the roster and today's default feed. */
export interface FeedModelState {
  roster: readonly ContestantSpec[];
  /** The single best performer (champion.ts): the AI reviewer's model, and the fallback below. */
  defaultModel: string;
  /**
   * The default feed: the top models by 24h 2x hit rate (topModels.ts), best first; just
   * [defaultModel] while too few models qualify.
   */
  defaultModels: string[];
  /** The best average exit-plan return over the same 24h (the "best" marker); null when none qualify. */
  bestModel: string | null;
}

/** The default feed: the top models when enough qualify, else the single default. */
export function resolveDefaultModels(top: readonly string[] | null, defaultModel: string): string[] {
  return top && top.length > 0 ? [...top] : [defaultModel];
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
 * The ledgers the combined feed reads: the default feed (the top models) while the user follows
 * it; else their checked models that are still on the roster, in roster order, else their single
 * pick, else the default feed. `followsDefault` is true when the feed is showing the default.
 */
export function resolveFeedModels(
  state: FeedModelState,
  saved: SavedFeedModels,
): { models: string[]; followsDefault: boolean } {
  if (saved.followBest) return { models: [...state.defaultModels], followsDefault: true };
  const checked = new Set(saved.models);
  const models = state.roster.filter((c) => checked.has(c.id)).map((c) => c.id);
  if (models.length > 0) return { models, followsDefault: false };
  if (saved.model !== null && state.roster.some((c) => c.id === saved.model)) {
    return { models: [saved.model], followsDefault: false };
  }
  return { models: [...state.defaultModels], followsDefault: true };
}

/** What a user saved about Telegram's models: the User columns the dispatcher reads. */
export interface SavedTelegramModels {
  /** Telegram carries the Live Feed's models (the default); off = `models` below decide. */
  sameAsFeed: boolean;
  /** Telegram's own picks while sameAsFeed is off; empty = follow the top models. */
  models: string[];
}

/**
 * The models whose calls go to a user's Telegram chats. While Telegram follows the Live Feed it is
 * the feed's list, and nothing when the feed shows no model calls. With its own picks it is those
 * still on the roster, else the top models; the feed's on/off switch doesn't apply then, so the
 * Live Feed can be filter matches only while Telegram still gets calls.
 */
export function resolveTelegramModels(
  state: FeedModelState,
  feed: SavedFeedModels & { showModelAlerts: boolean },
  telegram: SavedTelegramModels,
): { models: string[]; followsDefault: boolean } {
  if (telegram.sameAsFeed) {
    const resolved = resolveFeedModels(state, feed);
    return feed.showModelAlerts ? resolved : { models: [], followsDefault: resolved.followsDefault };
  }
  return resolveFeedModels(state, {
    model: null,
    models: telegram.models,
    followBest: telegram.models.length === 0,
  });
}

/**
 * The roster and the default feed as the worker sees them: the same reads the API's
 * contestState makes (lanes, the champion, each contestant's active cutoff, the 24h top models),
 * without its cache.
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
  const defaultModel = resolveDefaultModel(
    champion?.contestant ?? null,
    canCall,
    defaultContestant(consensusEnabled ? cutoffs.get(CONSENSUS_CONTESTANT)?.threshold : null),
  );
  const exams = new Map(roster.map((c) => [c.id, cutoffs.get(c.id)?.metrics.exam]));
  const { top, best } = await loadTopModels(roster, lanes, canCall, exams, curatedTargets(env));
  return { roster, defaultModel, defaultModels: resolveDefaultModels(top, defaultModel), bestModel: best };
}
