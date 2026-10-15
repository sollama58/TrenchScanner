import type { Prisma } from "@prisma/client";
import type { Env } from "../config/env.js";
import { prisma } from "../db.js";
import { activeModelCutoffs, loadChampion, resolveDefaultModel } from "./champion.js";
import {
  COMBINER_ROLES,
  CONSENSUS_CONTESTANT,
  enabledContestants,
  type ContestantSpec,
} from "./contestants.js";
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
   * The default feed: the top models by 2x lower bound (topModels.ts), best first, then the
   * champion when it isn't among them; just [defaultModel] while no model qualifies.
   */
  defaultModels: string[];
  /** The best average exit-plan return over the same 24h (the "best" marker); null when none qualify. */
  bestModel: string | null;
}

/**
 * The default feed: the top models by 2x lower bound (up to TOP_MODELS_COUNT), plus the champion
 * when it did not rank among them - so 4 models at most, 3 when the champion is already in the top
 * 3 (user decision 2026-10-15; before it the champion replaced the third pick, leaving 3). With no
 * model ranked it is just the single default. A fallback default standing in for a silent
 * champion is not added.
 */
export function resolveDefaultModels(
  top: readonly string[] | null,
  defaultModel: string,
  champion: string | null,
): string[] {
  if (!top || top.length === 0) return [defaultModel];
  const models = [...top];
  if (champion !== null && champion === defaultModel && !models.includes(champion)) models.push(champion);
  return models;
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
 * The roster's combiners that are sitting out: a member's active model is not the one the
 * combiner was trained beside, so the worker won't let it call until the next run (see the
 * `usable` filter in the worker's curatedAlerts.ts). The API and the dispatcher read who can call
 * from the stored cutoffs alone, which can't see this, so a sitting-out combiner could hold a top
 * models slot (or be the default) while it sent nothing. Only the combiners' member lists are
 * read off params; a learner's params (its whole model) are never loaded.
 */
export async function sittingOutCombiners(roster: readonly ContestantSpec[]): Promise<Set<string>> {
  const combiners = roster.filter((c) => COMBINER_ROLES.includes(c.role)).map((c) => c.id);
  if (combiners.length === 0) return new Set();
  const rows = await prisma.$queryRaw<{ contestant: string }[]>`
    WITH active AS (
      SELECT DISTINCT ON ("contestant") "id", "contestant"
      FROM "CuratorModel"
      WHERE "status" = 'active' AND "contestant" IS NOT NULL
      ORDER BY "contestant", "createdAt" DESC
    ),
    combiner AS (
      SELECT DISTINCT ON ("contestant") "contestant", "params"->'members' AS members
      FROM "CuratorModel"
      WHERE "status" = 'active' AND "contestant" = ANY(${combiners})
      ORDER BY "contestant", "createdAt" DESC
    )
    SELECT DISTINCT c."contestant"
    FROM combiner c
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(c.members) = 'array' THEN c.members ELSE '[]'::jsonb END
    ) AS m
    WHERE NOT EXISTS (
      SELECT 1 FROM active a WHERE a."contestant" = m->>'contestant' AND a."id" = m->>'modelId'
    )`;
  return new Set(rows.map((r) => r.contestant));
}

/** CuratedAlert.tier on a call that cleared its model's high-conviction line. */
export const HIGH_CONVICTION_TIER = "high";

/**
 * The calls a feed carries: every call of `models`, or, with `tier` set, only the calls of that
 * tier. The feed's own rule decides the models (resolveFeedModels, resolveTelegramModels, or the
 * high-conviction tier below); this is what both the API and the dispatcher query by.
 */
export interface FeedCalls {
  models: string[];
  /** Only calls of this CuratedAlert.tier; null = every call. */
  tier: string | null;
}

/**
 * The high-conviction tier as a feed of its own (user decision 2026-10-14, full audit P10): every
 * roster model's calls that cleared that model's high-conviction line, whatever models the
 * reader follows. It is the tier the site's tier stats count (every model, one card per token)
 * and the slice the audit measured at 31% 2x against 20% for standard calls, at about 26 calls a
 * day across the field. One model's high calls alone are too few to carry a feed.
 */
export function highConvictionCalls(state: Pick<FeedModelState, "roster">): FeedCalls {
  return { models: state.roster.map((c) => c.id), tier: HIGH_CONVICTION_TIER };
}

/**
 * A reader's feed calls: their models' calls (`models`, from resolveFeedModels or
 * resolveTelegramModels), or the high-conviction tier when they asked for it alone.
 */
export function resolveFeedCalls(
  state: Pick<FeedModelState, "roster">,
  models: readonly string[],
  highConvictionOnly: boolean,
): FeedCalls {
  return highConvictionOnly ? highConvictionCalls(state) : { models: [...models], tier: null };
}

/** The CuratedAlert filter for a feed's calls. */
export function feedCallsWhere(calls: FeedCalls): Prisma.CuratedAlertWhereInput {
  return { model: { in: calls.models }, ...(calls.tier === null ? {} : { tier: calls.tier }) };
}

/** Whether one call belongs to a feed's calls: feedCallsWhere, on a row already read. */
export function isFeedCall(calls: FeedCalls, call: { model: string | null; tier: string | null }): boolean {
  return (
    call.model !== null &&
    calls.models.includes(call.model) &&
    (calls.tier === null || call.tier === calls.tier)
  );
}

/** A stable cache-key part for a feed's calls. */
export function feedCallsKey(calls: FeedCalls): string {
  return calls.tier === null ? calls.models.join(",") : `tier=${calls.tier}:${calls.models.join(",")}`;
}

/**
 * The roster and the default feed as the worker sees them: the same reads the API's
 * contestState makes (lanes, the champion, each contestant's active cutoff, sitting-out
 * combiners, the top models), without its cache.
 */
export async function loadFeedModelState(env: Env): Promise<FeedModelState> {
  const [lanes, champion] = await Promise.all([loadCurrentLanes(), loadChampion()]);
  const roster = withLanes(enabledContestants(env.CURATOR_CONTESTANTS), lanes);
  const ids = roster.map((c) => c.id);
  const [cutoffs, sittingOut] = await Promise.all([activeModelCutoffs(ids), sittingOutCombiners(roster)]);
  const canCall = (id: string) => {
    const spec = roster.find((c) => c.id === id);
    if (!spec) return false;
    if (spec.role === "rules") return true;
    if (sittingOut.has(id)) return false;
    const threshold = cutoffs.get(id)?.threshold;
    return typeof threshold === "number" && threshold < NEVER_EMIT_THRESHOLD;
  };
  const consensusEnabled = roster.some((c) => c.id === CONSENSUS_CONTESTANT);
  const defaultModel = resolveDefaultModel(
    champion?.contestant ?? null,
    canCall,
    defaultContestant(consensusEnabled ? cutoffs.get(CONSENSUS_CONTESTANT)?.threshold : null),
  );
  const { top, best } = await loadTopModels(roster, lanes, canCall);
  return {
    roster,
    defaultModel,
    defaultModels: resolveDefaultModels(top, defaultModel, champion?.contestant ?? null),
    bestModel: best,
  };
}
