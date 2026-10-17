import { prisma } from "../db.js";
import { createLogger } from "../logger.js";

const logger = createLogger("ai-switch");

/**
 * The Admin panel's AI reviewer switch (the AiReviewerSwitch row). It sits on top of
 * ANTHROPIC_API_KEY and AI_REVIEW_MODE, which still have to allow a run:
 *
 * - "off" (the default, and what no row reads as): no Claude calls at all - no reviews, no
 *   replays or playbook rounds, no text reads - whatever the key and the mode say.
 * - "admins": the testing state. The reviewer runs in shadow (a gate-mode setting is held to
 *   shadow), its verdicts are shown to admins only, and a live trading bot never reads them, so
 *   the feed, Telegram and every real-money buy behave exactly as with the reviewer off. Paper
 *   strategies do read them: that is how an admin tests a bot that follows the judge.
 * - "live": AI_REVIEW_MODE in full - a qualified gate can hold picks back, and a live bot with
 *   "Only buy what the AI judge calls a buy" follows its verdicts.
 *
 * Read with a short cache: the worker asks every scan cycle and every text read.
 */
export const AI_REVIEWER_STATES = ["off", "admins", "live"] as const;
export type AiReviewerState = (typeof AI_REVIEWER_STATES)[number];

const SWITCH_ID = "ai-reviewer";
const CACHE_MS = 30_000;

let cached: { state: AiReviewerState; fetchedAt: number } | null = null;
let refreshing: Promise<AiReviewerState> | null = null;

function asState(value: string | null | undefined): AiReviewerState {
  return (AI_REVIEWER_STATES as readonly string[]).includes(value ?? "") ? (value as AiReviewerState) : "off";
}

/** The switch as stored, fresh from the database (the Admin panel's read). */
export async function readAiReviewerSwitch(): Promise<{
  state: AiReviewerState;
  updatedBy: string | null;
  updatedAt: Date | null;
}> {
  const row = await prisma.aiReviewerSwitch.findUnique({ where: { id: SWITCH_ID } });
  return { state: asState(row?.state), updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null };
}

/**
 * The switch, cached for CACHE_MS. A failed read keeps the last known state, or "off" before the
 * first good one: an unreadable switch must never start spend.
 */
export async function aiReviewerState(now = Date.now()): Promise<AiReviewerState> {
  if (cached && now - cached.fetchedAt < CACHE_MS) return cached.state;
  refreshing ??= readAiReviewerSwitch()
    .then(({ state }) => {
      cached = { state, fetchedAt: Date.now() };
      return state;
    })
    .catch((err: unknown) => {
      logger.warn("could not read the AI reviewer switch - keeping the last state", { error: String(err) });
      return cached?.state ?? "off";
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/**
 * The last state read, for callers that can't wait (the text scorer, called inside the scan):
 * a stale cache starts a refresh in the background. "off" until the first read lands.
 */
export function cachedAiReviewerState(now = Date.now()): AiReviewerState {
  if (!cached || now - cached.fetchedAt >= CACHE_MS) void aiReviewerState(now);
  return cached?.state ?? "off";
}

export async function setAiReviewerSwitch(state: AiReviewerState, by: string): Promise<AiReviewerState> {
  const row = await prisma.aiReviewerSwitch.upsert({
    where: { id: SWITCH_ID },
    create: { id: SWITCH_ID, state, updatedBy: by },
    update: { state, updatedBy: by },
  });
  cached = { state: asState(row.state), fetchedAt: Date.now() };
  return cached.state;
}

/** Test hook. */
export function resetAiReviewerSwitchCache(state?: AiReviewerState): void {
  cached = state ? { state, fetchedAt: Number.MAX_SAFE_INTEGER / 2 } : null;
  refreshing = null;
}
