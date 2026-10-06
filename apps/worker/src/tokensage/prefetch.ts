import {
  prisma,
  createLogger,
  HttpError,
  TokenSageClient,
  TOKENSAGE_BATCH_MAX,
  narrativeDepthCovers,
  narrativeFieldsFromAnalysis,
  type Env,
  type TokenSageAnalysis,
  type TokenSageDepth,
  type TokenSageHints,
} from "@trenchscanner/core";
import type { Prisma } from "@prisma/client";

const logger = createLogger("tokensage");

/**
 * Asks TokenSage what each candidate is about and stores the answer in TokenNarrative.
 *
 * The scan notes the mints it wants (noteNarrativeWanted), with what discovery already knows
 * about them as hints: basic depth the first time a mint passes the rug screen inside the
 * curated band, full depth (which also reads the X link, its match with the token, and trends)
 * when the mint gets a decision ("event") row. At the end of each cycle flushNarrativeRequests
 * sends them in batches and is never awaited: nothing in the scan, matching or alerting path
 * waits on TokenSage. A batch answers cached mints at once and queues the rest; a queued mint is
 * simply re-sent in the next cycle's batch, which joins its open job for free and returns the
 * analysis once done. That keeps us to a couple of requests a cycle, far inside TokenSage's
 * 60/min per key, where polling each job would not be.
 *
 * Failures cost only the narrative:
 * - a 429 or 503 on the whole batch pauses requests for a minute;
 * - an item turned away for quota or load is re-sent later, and once the day's full-depth quota
 *   is spent (X-Quota-Full-Remaining, or our own TOKENSAGE_FULL_PER_DAY) full requests fall
 *   back to basic until midnight UTC;
 * - a mint TokenSage can't analyse is cached as "failed" so it isn't asked again;
 * - a partial answer (an upstream source failed, or the mint isn't on-chain yet) is stored and
 *   asked again a little later, a few times;
 * - a mint still pending after PENDING_GIVE_UP_MS is dropped.
 * Everything here is in-process, so a restart forgets the queue and the day's count; mints still
 * in band are noted again on the next scan.
 */

const PENDING_GIVE_UP_MS = 5 * 60_000;
const PAUSE_AFTER_REFUSAL_MS = 60_000;
/** TokenSage caches a partial answer for 60 s; ask again after that, at most this many times. */
const PARTIAL_RETRY_MS = 90_000;
const PARTIAL_MAX_RETRIES = 3;
/** Mints noted but not yet sent are kept at most this many (oldest dropped). */
const MAX_WANTED = 2_000;
const MAX_SETTLED = 20_000;

interface Wanted {
  depth: TokenSageDepth;
  hints?: TokenSageHints;
}

interface Pending {
  depth: TokenSageDepth;
  hints?: TokenSageHints;
  since: number;
}

interface Settled {
  depth: TokenSageDepth;
  /** Set while a partial answer may still be asked again: when, and how many times so far. */
  partialAt?: number;
  partialTries?: number;
}

const wanted = new Map<string, Wanted>();
const pending = new Map<string, Pending>();
/** Mints already stored at a depth (or cached as failed), so the scan's per-cycle notes are free. */
const settled = new Map<string, Settled>();
let flushing = false;
let pausedUntil = 0;
let fullDay = "";
let fullSentToday = 0;
/** Full-depth requests fall back to basic until this time (TokenSage's daily quota is spent). */
let fullBlockedUntil = 0;

interface Stats {
  requested: number;
  stored: number;
  failed: number;
  turnedAway: number;
  errors: number;
}
const NO_STATS: Stats = { requested: 0, stored: 0, failed: 0, turnedAway: 0, errors: 0 };
let stats: Stats = { ...NO_STATS };

/** Test hook. */
export function resetTokenSage(): void {
  wanted.clear();
  pending.clear();
  settled.clear();
  flushing = false;
  pausedUntil = 0;
  fullDay = "";
  fullSentToday = 0;
  fullBlockedUntil = 0;
  stats = { ...NO_STATS };
}

export function tokenSageEnabled(env: Env): boolean {
  return env.TOKENSAGE_ENABLED && env.TOKENSAGE_API_URL !== "" && env.TOKENSAGE_API_KEY !== "";
}

function settledCovers(mintAddress: string, depth: TokenSageDepth, now: number): boolean {
  const s = settled.get(mintAddress);
  if (!s || !narrativeDepthCovers(s.depth, depth)) return false;
  // A partial answer is worth asking for again once TokenSage would re-analyse it.
  if (s.partialAt !== undefined && now - s.partialAt >= PARTIAL_RETRY_MS) {
    return (s.partialTries ?? 0) >= PARTIAL_MAX_RETRIES;
  }
  return true;
}

/** Notes that the scan wants this mint's narrative at `depth`. Cheap; does no IO. */
export function noteNarrativeWanted(
  mintAddress: string,
  depth: TokenSageDepth,
  env: Env,
  hints?: TokenSageHints,
): void {
  if (!tokenSageEnabled(env)) return;
  if (settledCovers(mintAddress, depth, Date.now())) return;
  const have = wanted.get(mintAddress);
  if (have?.depth === "full") return;
  if (!have && wanted.size >= MAX_WANTED) {
    const oldest = wanted.keys().next().value;
    if (oldest !== undefined) wanted.delete(oldest);
  }
  wanted.set(mintAddress, { depth, hints: hints ?? have?.hints });
}

/** Counters since the last read, for the scan cycle's summary on /health/worker. */
export function takeTokenSageStats(): Record<string, number> {
  const out = { ...stats, waiting: wanted.size, pending: pending.size, fullToday: fullSentToday };
  stats = { ...NO_STATS };
  return out;
}

function settle(mintAddress: string, depth: TokenSageDepth, partial: boolean): void {
  if (settled.size >= MAX_SETTLED) settled.clear();
  const prev = settled.get(mintAddress);
  settled.set(
    mintAddress,
    partial
      ? { depth, partialAt: Date.now(), partialTries: (prev?.partialTries ?? 0) + (prev?.partialAt ? 1 : 0) }
      : { depth },
  );
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function isRefusal(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 429 || err.status === 503);
}

async function storeAnalysis(analysis: TokenSageAnalysis, status: "complete" | "partial"): Promise<void> {
  const fields = narrativeFieldsFromAnalysis(analysis, status);
  const existing = await prisma.tokenNarrative.findUnique({
    where: { mintAddress: analysis.mint },
    select: { depth: true, status: true },
  });
  // A shallower answer that lands after a deeper one must not overwrite it, and neither may a
  // partial answer overwrite a complete one at the same depth.
  if (existing && existing.status !== "failed") {
    const deeper = !narrativeDepthCovers(fields.depth, existing.depth as TokenSageDepth);
    const worse = existing.depth === fields.depth && existing.status === "complete" && status === "partial";
    if (deeper || worse) {
      settle(analysis.mint, existing.depth as TokenSageDepth, false);
      return;
    }
  }
  const data = {
    ...fields,
    categories: fields.categories as unknown as Prisma.InputJsonValue,
    analysis: analysis as unknown as Prisma.InputJsonValue,
    checkedAt: new Date(),
  };
  await prisma.tokenNarrative.upsert({
    where: { mintAddress: analysis.mint },
    create: { mintAddress: analysis.mint, ...data },
    update: data,
  });
  stats.stored += 1;
  settle(analysis.mint, fields.depth, status === "partial");
}

async function storeFailure(mintAddress: string, depth: TokenSageDepth): Promise<void> {
  const existing = await prisma.tokenNarrative.findUnique({
    where: { mintAddress },
    select: { status: true },
  });
  if (existing && existing.status !== "failed") return;
  await prisma.tokenNarrative.upsert({
    where: { mintAddress },
    create: { mintAddress, depth, status: "failed", checkedAt: new Date() },
    update: { depth, status: "failed", checkedAt: new Date() },
  });
  stats.failed += 1;
  settle(mintAddress, "full", false);
}

/**
 * Sends what the scan noted, plus what TokenSage still has queued. Call without awaiting; a
 * flush already running makes this a no-op. Resolves when done, for tests.
 */
export async function flushNarrativeRequests(env: Env, client?: TokenSageClient): Promise<void> {
  if (!tokenSageEnabled(env) || flushing) return;
  const now = Date.now();
  if (now < pausedUntil) return;
  flushing = true;
  const api =
    client ??
    new TokenSageClient({
      baseUrl: env.TOKENSAGE_API_URL,
      apiKey: env.TOKENSAGE_API_KEY,
      timeoutMs: env.TOKENSAGE_TIMEOUT_MS,
    });
  try {
    await send(api, env, now);
  } catch (err) {
    stats.errors += 1;
    if (isRefusal(err)) {
      pausedUntil = Date.now() + PAUSE_AFTER_REFUSAL_MS;
      logger.warn("TokenSage refused requests; pausing", { status: (err as HttpError).status });
    } else {
      logger.warn("TokenSage flush failed", { error: String(err) });
    }
  } finally {
    flushing = false;
  }
}

async function send(api: TokenSageClient, env: Env, now: number): Promise<void> {
  if (env.TOKENSAGE_MAX_BATCHES_PER_CYCLE === 0) return;
  const day = utcDay(now);
  if (day !== fullDay) {
    fullDay = day;
    fullSentToday = 0;
  }
  const fullOpen = now >= fullBlockedUntil;

  // Queued on TokenSage's side: re-sent first (free), until they finish or we give up on them.
  const byDepth: Record<TokenSageDepth, { ca: string; hints?: TokenSageHints }[]> = { full: [], basic: [] };
  for (const [mint, p] of pending) {
    if (now - p.since > PENDING_GIVE_UP_MS) {
      pending.delete(mint);
      stats.errors += 1;
      continue;
    }
    if (p.depth === "full" && !fullOpen) continue;
    byDepth[p.depth].push({ ca: mint, hints: p.hints });
  }

  // Newly noted: drop what's already stored deep enough (or queued).
  const fresh = [...wanted.keys()].filter((m) => !pending.has(m) || wanted.get(m)!.depth === "full");
  const stored =
    fresh.length > 0
      ? await prisma.tokenNarrative.findMany({
          where: { mintAddress: { in: fresh } },
          select: { mintAddress: true, depth: true, status: true },
        })
      : [];
  const storedByMint = new Map(stored.map((r) => [r.mintAddress, r]));
  let fullBudget = fullOpen ? Math.max(0, env.TOKENSAGE_FULL_PER_DAY - fullSentToday) : 0;
  for (const [mint, w] of wanted) {
    const queued = pending.get(mint);
    if (queued && narrativeDepthCovers(queued.depth, w.depth)) {
      wanted.delete(mint);
      continue;
    }
    const row = storedByMint.get(mint);
    if (row && (row.status === "failed" || narrativeDepthCovers(row.depth, w.depth))) {
      // A partial answer the scan asked for again (settledCovers let it through) is re-sent.
      const retryPartial = row.status === "partial" && settled.get(mint)?.partialAt !== undefined;
      if (!retryPartial) {
        if (!settled.has(mint))
          settle(mint, row.status === "failed" ? "full" : (row.depth as TokenSageDepth), false);
        wanted.delete(mint);
        continue;
      }
    }
    if (w.depth === "full" && fullBudget > 0) {
      fullBudget -= 1;
      byDepth.full.push({ ca: mint, hints: w.hints });
    } else if (queued || (w.depth === "full" && row && row.status !== "failed")) {
      // Out of full-depth quota with a basic answer stored or on its way: the full request
      // stays noted for when the quota is back.
      continue;
    } else {
      byDepth.basic.push({ ca: mint, hints: w.hints });
    }
  }

  // Full first: those are the mints a model is deciding on right now.
  let batches = env.TOKENSAGE_MAX_BATCHES_PER_CYCLE;
  for (const depth of ["full", "basic"] as const) {
    let list = byDepth[depth];
    while (list.length > 0 && batches > 0) {
      const chunk = list.slice(0, TOKENSAGE_BATCH_MAX);
      list = list.slice(TOKENSAGE_BATCH_MAX);
      batches -= 1;
      const { items, fullRemaining } = await api.batch(chunk, depth);
      if (fullRemaining === 0) fullBlockedUntil = nextUtcMidnight(Date.now());
      const sent = new Map(chunk.map((e) => [e.ca, e]));
      for (const e of chunk) {
        const w = wanted.get(e.ca);
        if (w && narrativeDepthCovers(depth, w.depth)) wanted.delete(e.ca);
      }
      for (const item of items) {
        const entry = sent.get(item.ca);
        if (!entry) continue;
        const wasPending = pending.has(item.ca);
        if (!wasPending) {
          stats.requested += 1;
          if (depth === "full") fullSentToday += 1;
        }
        if ((item.status === "complete" || item.status === "partial") && item.analysis) {
          pending.delete(item.ca);
          await storeAnalysis(item.analysis, item.status);
        } else if (item.status === "pending") {
          if (!wasPending) pending.set(item.ca, { depth, hints: entry.hints, since: Date.now() });
        } else if (
          item.status === "failed" &&
          (item.error === "quota_exceeded" || item.error === "overloaded")
        ) {
          // Turned away, not analysed: ask again later (as basic, once full is out of quota).
          pending.delete(item.ca);
          stats.turnedAway += 1;
          if (item.error === "quota_exceeded" && depth === "full") {
            fullBlockedUntil = nextUtcMidnight(Date.now());
          } else {
            pausedUntil = Math.max(pausedUntil, Date.now() + Math.max(5, item.retry_after_s ?? 30) * 1000);
          }
          if (!wanted.has(item.ca)) wanted.set(item.ca, { depth, hints: entry.hints });
        } else if (item.status === "invalid" || item.status === "failed") {
          pending.delete(item.ca);
          // token_not_found on a seconds-old mint can clear up; anything else is definitive.
          if (!String(item.error ?? "").startsWith("token_not_found")) await storeFailure(item.ca, depth);
        }
      }
    }
  }
}
