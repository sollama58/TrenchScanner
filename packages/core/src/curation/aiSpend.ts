import { prisma } from "../db.js";
import type { Env } from "../config/env.js";

/**
 * The AI's daily spend ledger and what it costs to ask Claude. Every Anthropic call the worker
 * makes (apps/worker/src/ai/budget.ts) reserves its estimated cost in the AiSpend table before it
 * runs and is trued up to the real cost from the response's usage afterwards, so the scanner
 * (live reviews, text reads) and the trainer (playbook reviews, replay batches) draw on one
 * AI_DAILY_BUDGET_USD per UTC day. The API reads the same rows for /health/worker and the Admin
 * tab.
 */

/** Where the spend goes. "review-spare" is a review of a standard (not high-conviction) pick. */
export type AiSpendSource = "review" | "review-spare" | "text" | "playbook" | "replay";
export const AI_SPEND_SOURCES: readonly AiSpendSource[] = [
  "review",
  "review-spare",
  "text",
  "playbook",
  "replay",
];

/**
 * Who gets the money first. "live" (reviews of high-conviction picks) may spend up to the cap;
 * "background" (everything else) stops short of it, at the cap less AI_BUDGET_REVIEW_RESERVE_PCT.
 */
export type AiSpendPriority = "live" | "background";

/** Per-million-token USD rates. Cache writes (5-minute TTL) bill at 1.25x input. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * Anthropic first-party list prices, per million tokens (checked 2026-10-04 against the
 * claude-api reference). A dated snapshot id resolves to its family. An id not listed here is
 * priced as the most expensive model, so a new or mistyped model id can only make the cap trip
 * early, never late.
 */
const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};
const UNKNOWN_MODEL_PRICE: ModelPrice = { input: 10, output: 50, cacheRead: 1 };
const CACHE_WRITE_MULTIPLIER = 1.25;
/** Message Batches bill every token at half the live rate. */
const BATCH_DISCOUNT = 0.5;

export function modelPrice(model: string): ModelPrice {
  const id = model.replace(/^anthropic\./, "");
  let best: string | null = null;
  for (const prefix of Object.keys(MODEL_PRICES)) {
    // The bare id, or the id with a date snapshot ("-20251001", or Vertex's "@20251001").
    const matches = id.startsWith(prefix) && /^([-@]\d{8})?$/.test(id.slice(prefix.length));
    if (matches && (best === null || prefix.length > best.length)) best = prefix;
  }
  return best ? MODEL_PRICES[best]! : UNKNOWN_MODEL_PRICE;
}

/** The usage fields of a Messages API response that cost money. */
export interface AiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * What one response cost, in USD. `models` is every model that may have billed the call - the one
 * asked and the one that answered (a server-side fallback can differ) - and the dearest is used,
 * so the ledger errs high.
 */
export function usageCostUsd(
  models: string | (string | null | undefined)[],
  usage: AiUsage,
  opts: { batch?: boolean } = {},
): number {
  const ids = (Array.isArray(models) ? models : [models]).filter((m): m is string => !!m);
  const costs = (ids.length > 0 ? ids : ["unknown"]).map((m) => {
    const p = modelPrice(m);
    const usd =
      (usage.input_tokens * p.input +
        (usage.cache_creation_input_tokens ?? 0) * p.input * CACHE_WRITE_MULTIPLIER +
        (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
        usage.output_tokens * p.output) /
      1_000_000;
    return opts.batch ? usd * BATCH_DISCOUNT : usd;
  });
  return Math.max(...costs);
}

/** A rough cost for a call shape before it runs: input and output tokens at the model's rates. */
export function estimateCostUsd(
  model: string,
  tokens: { input: number; output: number },
  opts: { batch?: boolean } = {},
): number {
  return usageCostUsd(model, { input_tokens: tokens.input, output_tokens: tokens.output }, opts);
}

/** The ledger's day for a moment: its UTC date, YYYY-MM-DD. */
export function aiSpendDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** The next UTC midnight after `at` - when the day's budget resets. */
export function aiBudgetResetsAt(at: Date = new Date()): Date {
  const d = new Date(at);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

/** The USD a priority may spend in a day, given the cap and the high-conviction reserve. */
export function aiSpendLimitUsd(
  env: Pick<Env, "AI_DAILY_BUDGET_USD" | "AI_BUDGET_REVIEW_RESERVE_PCT">,
  priority: AiSpendPriority,
): number {
  const cap = env.AI_DAILY_BUDGET_USD;
  return priority === "live" ? cap : cap * (1 - env.AI_BUDGET_REVIEW_RESERVE_PCT / 100);
}

/**
 * Adds to one (day, source) row of the ledger, creating it if needed. Deltas may be negative (a
 * true-up below the reservation, or a refund). One statement, so concurrent writers from both
 * worker processes add up rather than overwrite each other.
 */
export async function addAiSpend(
  day: string,
  source: AiSpendSource,
  delta: { costUsd?: number; calls?: number; refused?: number },
  capUsd: number,
): Promise<void> {
  const cost = delta.costUsd ?? 0;
  const calls = delta.calls ?? 0;
  const refused = delta.refused ?? 0;
  await prisma.$executeRaw`
    INSERT INTO "AiSpend" ("day", "source", "costUsd", "calls", "refused", "capUsd", "updatedAt")
    VALUES (${day}, ${source}, ${cost}, ${calls}, ${refused}, ${capUsd}, now())
    ON CONFLICT ("day", "source") DO UPDATE SET
      "costUsd" = "AiSpend"."costUsd" + EXCLUDED."costUsd",
      "calls" = "AiSpend"."calls" + EXCLUDED."calls",
      "refused" = "AiSpend"."refused" + EXCLUDED."refused",
      "capUsd" = EXCLUDED."capUsd",
      "updatedAt" = now()`;
}

/** Everything spent on `day`, in USD. */
export async function aiSpentUsd(day: string): Promise<number> {
  const agg = await prisma.aiSpend.aggregate({ where: { day }, _sum: { costUsd: true } });
  return agg._sum.costUsd ?? 0;
}

export interface AiBudgetStatus {
  day: string;
  /** The cap the worker last enforced (its own AI_DAILY_BUDGET_USD), or this process's when none yet. */
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  /** The share of the cap kept for high-conviction reviews. */
  reservePct: number;
  /** Live (high-conviction) reviews have stopped for the day: the cap is spent or a review was turned away. */
  stopped: boolean;
  /** Background work (text reads, playbook tests, standard-pick reviews) has paused for the day. */
  backgroundPaused: boolean;
  resetsAt: string;
  bySource: { source: string; costUsd: number; calls: number; refused: number }[];
}

const round = (usd: number) => Math.round(usd * 10_000) / 10_000;

/** Today's (UTC) budget as the ledger has it. */
export async function readAiBudget(
  env: Pick<Env, "AI_DAILY_BUDGET_USD" | "AI_BUDGET_REVIEW_RESERVE_PCT">,
  now: Date = new Date(),
): Promise<AiBudgetStatus> {
  const day = aiSpendDay(now);
  const rows = await prisma.aiSpend.findMany({ where: { day }, orderBy: { source: "asc" } });
  return summarizeAiBudget(env, day, rows, now);
}

/** The budget status for one day's ledger rows - pure, see readAiBudget. */
export function summarizeAiBudget(
  env: Pick<Env, "AI_DAILY_BUDGET_USD" | "AI_BUDGET_REVIEW_RESERVE_PCT">,
  day: string,
  rows: {
    source: string;
    costUsd: number;
    calls: number;
    refused: number;
    capUsd: number;
    updatedAt: Date;
  }[],
  now: Date = new Date(),
): AiBudgetStatus {
  const latest = rows.reduce<(typeof rows)[number] | null>(
    (a, r) => (a === null || r.updatedAt > a.updatedAt ? r : a),
    null,
  );
  const capUsd = latest?.capUsd ?? env.AI_DAILY_BUDGET_USD;
  const spentUsd = rows.reduce((s, r) => s + r.costUsd, 0);
  const refused = (sources: string[]) => rows.some((r) => sources.includes(r.source) && r.refused > 0);
  const backgroundLimit = aiSpendLimitUsd(
    { AI_DAILY_BUDGET_USD: capUsd, AI_BUDGET_REVIEW_RESERVE_PCT: env.AI_BUDGET_REVIEW_RESERVE_PCT },
    "background",
  );
  const stopped = spentUsd >= capUsd || refused(["review"]);
  return {
    day,
    capUsd,
    spentUsd: round(spentUsd),
    remainingUsd: round(Math.max(0, capUsd - spentUsd)),
    reservePct: env.AI_BUDGET_REVIEW_RESERVE_PCT,
    stopped,
    // A replay that didn't fit is trimmed or waits for tomorrow; only the steady trickle of text
    // reads and standard-pick reviews being turned away means background work has stopped.
    backgroundPaused: stopped || spentUsd >= backgroundLimit || refused(["text", "review-spare"]),
    resetsAt: aiBudgetResetsAt(now).toISOString(),
    bySource: rows.map((r) => ({
      source: r.source,
      costUsd: round(r.costUsd),
      calls: r.calls,
      refused: r.refused,
    })),
  };
}
