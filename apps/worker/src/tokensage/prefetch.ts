import {
  prisma,
  createLogger,
  HttpError,
  TokenSageClient,
  TOKENSAGE_BATCH_MAX,
  narrativeDepthCovers,
  narrativeFieldsFromAnalysis,
  storableAnalysis,
  tokenSageEnabled,
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
 * about them as hints: basic depth the first time a mint passes the rug screen on the watchlist
 * (any scanned mint, in band or still below it, so the read is usually stored before the band
 * entry that most first decisions follow within a minute), full depth (which also reads the X
 * link, its match with the token, and trends) when the mint gets a decision ("event") row.
 * A coin with an X link that reaches the watchlist young gets the full read at once instead
 * (its own daily budget, TOKENSAGE_EARLY_FULL_PER_DAY), and startNarrativePolling re-sends
 * what is queued between cycles. At the end of each cycle flushNarrativeRequests
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
 * on the watchlist are noted again on the next scan.
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
  /** A full read asked early (a young coin with an X link), on its own daily budget. */
  early?: boolean;
}

interface Pending {
  depth: TokenSageDepth;
  hints?: TokenSageHints;
  since: number;
  jobId?: number;
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
/**
 * Mints whose last analysis failed without a definitive reason (or that weren't on-chain yet),
 * left alone until the time stored. TokenSage answers any request within 10 minutes of a failed
 * job with that failure, so asking sooner only wastes a request - and for a definitive failure
 * it answers the whole batch 404/422 (see send), so the margin matters.
 */
const notFoundUntil = new Map<string, number>();
const NOT_FOUND_COOLDOWN_MS = 11 * 60_000;
/** Transient failures per mint; after this many it is cached as failed like a definitive one. */
const failCounts = new Map<string, number>();
const MAX_TRANSIENT_FAILURES = 3;
/** Old-job lookups per flush (see checkEndedJob). */
const MAX_JOB_CHECKS_PER_FLUSH = 5;
const DEFINITIVE_FAILURES = ["not_a_token_mint", "not_pumpfun", "invalid_ca"];
let flushing = false;
let pausedUntil = 0;
let fullDay = "";
let fullSentToday = 0;
let earlySentToday = 0;
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
  notFoundUntil.clear();
  failCounts.clear();
  flushing = false;
  pausedUntil = 0;
  fullDay = "";
  fullSentToday = 0;
  earlySentToday = 0;
  fullBlockedUntil = 0;
  stats = { ...NO_STATS };
}

export { tokenSageEnabled };

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
  opts: { early?: boolean } = {},
): void {
  if (!tokenSageEnabled(env)) return;
  const now = Date.now();
  if (settledCovers(mintAddress, depth, now)) return;
  const cooling = notFoundUntil.get(mintAddress);
  if (cooling !== undefined) {
    if (now < cooling) return;
    notFoundUntil.delete(mintAddress);
  }
  const have = wanted.get(mintAddress);
  const early = depth === "full" && opts.early === true;
  // A decision-row full read outranks an early one (it isn't held to the early budget).
  if (have?.depth === "full" && (!have.early || early)) return;
  if (!have && wanted.size >= MAX_WANTED) {
    const oldest = wanted.keys().next().value;
    if (oldest !== undefined) wanted.delete(oldest);
  }
  wanted.set(mintAddress, { depth, hints: hints ?? have?.hints, ...(early ? { early } : {}) });
}

/**
 * Re-sends what is queued every TOKENSAGE_POLL_SECONDS between scan cycles, so a finished read is
 * stored within seconds instead of at the next scan. Same flush as the scan's (a flush already
 * running makes it a no-op), so it adds requests only while something is waiting. Runs in the
 * process that scans, which holds the queue. Returns the stop function, or undefined when off.
 */
export function startNarrativePolling(env: Env, client?: TokenSageClient): (() => void) | undefined {
  if (!tokenSageEnabled(env) || env.TOKENSAGE_POLL_SECONDS <= 0) return undefined;
  const timer = setInterval(() => {
    if (pending.size === 0 && wanted.size === 0) return;
    void flushNarrativeRequests(env, client);
  }, env.TOKENSAGE_POLL_SECONDS * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Counters since the last read, for the scan cycle's summary on /health/worker. */
export function takeTokenSageStats(): Record<string, number> {
  const out = {
    ...stats,
    waiting: wanted.size,
    pending: pending.size,
    fullToday: fullSentToday,
    earlyFullToday: earlySentToday,
  };
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

/** Stored under the CA we asked about, not the document's own `mint` field. */
async function storeAnalysis(
  mint: string,
  analysis: TokenSageAnalysis,
  status: "complete" | "partial",
): Promise<void> {
  const fields = narrativeFieldsFromAnalysis(analysis, status);
  const existing = await prisma.tokenNarrative.findUnique({
    where: { mintAddress: mint },
    select: { depth: true, status: true },
  });
  // A shallower answer that lands after a deeper one must not overwrite it, and neither may a
  // partial answer overwrite a complete one at the same depth.
  if (existing && existing.status !== "failed") {
    const deeper = !narrativeDepthCovers(fields.depth, existing.depth as TokenSageDepth);
    const worse = existing.depth === fields.depth && existing.status === "complete" && status === "partial";
    if (deeper || worse) {
      settle(mint, existing.depth as TokenSageDepth, false);
      return;
    }
  }
  const data = {
    ...fields,
    categories: fields.categories as unknown as Prisma.InputJsonValue,
    failReason: null,
    analysis: (storableAnalysis(analysis) ?? {}) as Prisma.InputJsonValue,
    checkedAt: new Date(),
  };
  await prisma.tokenNarrative.upsert({
    where: { mintAddress: mint },
    create: { mintAddress: mint, ...data },
    update: data,
  });
  stats.stored += 1;
  failCounts.delete(mint);
  settle(mint, fields.depth, status === "partial");
}

async function storeFailure(mintAddress: string, depth: TokenSageDepth, reason: string): Promise<void> {
  failCounts.delete(mintAddress);
  const existing = await prisma.tokenNarrative.findUnique({
    where: { mintAddress },
    select: { status: true },
  });
  if (existing && existing.status !== "failed") {
    // A deeper read failed for a mint with an answer already stored: keep that one, stop asking.
    settle(mintAddress, "full", false);
    return;
  }
  const failReason = reason.split("\u0000").join("").trim().slice(0, 300) || null;
  await prisma.tokenNarrative.upsert({
    where: { mintAddress },
    create: { mintAddress, depth, status: "failed", failReason, checkedAt: new Date() },
    update: { depth, status: "failed", failReason, checkedAt: new Date() },
  });
  stats.failed += 1;
  settle(mintAddress, "full", false);
}

/**
 * An analysis that failed. TokenSage's reason starts with its code ("not_pumpfun: ..."): a
 * definitive one is cached for good; anything else (a mint not on-chain yet, an upstream
 * outage) is left alone past TokenSage's 10-minute failure window, and cached as failed after
 * a few tries.
 */
async function noteFailure(mint: string, depth: TokenSageDepth, error: unknown): Promise<void> {
  pending.delete(mint);
  const reason = typeof error === "string" && error.trim() !== "" ? error : "analysis failed";
  const code = reason.split(":")[0]!.trim();
  const tries = (failCounts.get(mint) ?? 0) + 1;
  if (DEFINITIVE_FAILURES.includes(code) || tries >= MAX_TRANSIENT_FAILURES) {
    await storeFailure(mint, depth, reason);
    return;
  }
  if (failCounts.size >= 5_000) failCounts.clear();
  failCounts.set(mint, tries);
  notFoundUntil.set(mint, Date.now() + NOT_FOUND_COOLDOWN_MS);
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
    earlySentToday = 0;
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
  let earlyBudget = Math.max(0, env.TOKENSAGE_EARLY_FULL_PER_DAY - earlySentToday);
  const earlyMints = new Set<string>();
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
    if (w.depth === "full" && fullBudget > 0 && (!w.early || earlyBudget > 0)) {
      fullBudget -= 1;
      if (w.early) {
        earlyBudget -= 1;
        earlyMints.add(mint);
      }
      byDepth.full.push({ ca: mint, hints: w.hints });
    } else if (w.early) {
      // Out of early budget: the basic read, as for any other coin, unless one is on its way.
      if (queued || row) wanted.delete(mint);
      else byDepth.basic.push({ ca: mint, hints: w.hints });
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
  let jobChecks = MAX_JOB_CHECKS_PER_FLUSH;
  for (const depth of ["full", "basic"] as const) {
    let list = byDepth[depth];
    while (list.length > 0 && batches > 0) {
      const chunk = list.slice(0, TOKENSAGE_BATCH_MAX);
      list = list.slice(TOKENSAGE_BATCH_MAX);
      batches -= 1;
      let result;
      try {
        result = await api.batch(chunk, depth);
      } catch (err) {
        if (!(err instanceof HttpError) || (err.status !== 404 && err.status !== 422)) throw err;
        // TokenSage answers the whole batch 404/422 when one re-sent mint's job failed
        // definitively (token_not_found, not_pumpfun, ...) in the last 10 minutes. Find it by
        // reading the queued mints' jobs, so the next batch goes through.
        stats.errors += 1;
        for (const e of chunk) {
          const p = pending.get(e.ca);
          if (p?.jobId === undefined || jobChecks <= 0) continue;
          jobChecks -= 1;
          await checkEndedJob(api, e.ca, p, p.jobId);
        }
        continue;
      }
      const { items, fullRemaining } = result;
      if (fullRemaining === 0) fullBlockedUntil = nextUtcMidnight(Date.now());
      const sent = new Map(chunk.map((e) => [e.ca, e]));
      for (const e of chunk) {
        const w = wanted.get(e.ca);
        if (w && narrativeDepthCovers(depth, w.depth)) wanted.delete(e.ca);
      }
      for (const item of items) {
        const entry = typeof item?.ca === "string" ? sent.get(item.ca) : undefined;
        if (!entry) continue;
        try {
          const wasPending = pending.has(item.ca);
          if (!wasPending) {
            stats.requested += 1;
            if (depth === "full") fullSentToday += 1;
            if (depth === "full" && earlyMints.has(item.ca)) earlySentToday += 1;
          }
          if (
            (item.status === "complete" || item.status === "partial") &&
            item.analysis !== null &&
            typeof item.analysis === "object"
          ) {
            pending.delete(item.ca);
            await storeAnalysis(item.ca, item.analysis, item.status);
          } else if (item.status === "pending") {
            const prev = pending.get(item.ca);
            const jobId = typeof item.job_id === "number" ? item.job_id : undefined;
            if (!prev || !narrativeDepthCovers(prev.depth, depth)) {
              pending.set(item.ca, { depth, hints: entry.hints, since: prev?.since ?? Date.now(), jobId });
            } else if (prev.jobId !== undefined && jobId !== undefined && jobId !== prev.jobId) {
              // A re-send that comes back under a new job means the old one ended without an
              // analysis; TokenSage's batch doesn't say why, so read the old job once.
              const ended = prev.jobId;
              prev.jobId = jobId;
              if (jobChecks > 0) {
                jobChecks -= 1;
                await checkEndedJob(api, item.ca, prev, ended);
              }
            }
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
          } else if (item.status === "invalid") {
            pending.delete(item.ca);
            await storeFailure(item.ca, depth, `invalid_ca: ${item.error ?? "not a token address"}`);
          } else if (item.status === "failed") {
            // TokenSage reports a failed job for 10 minutes without starting a new one.
            await noteFailure(item.ca, depth, item.error);
          } else {
            // A done status without a document, or a status this version doesn't know: ask again
            // after a cool-off rather than every cycle.
            pending.delete(item.ca);
            notFoundUntil.set(item.ca, Date.now() + NOT_FOUND_COOLDOWN_MS);
          }
        } catch (err) {
          // One bad item (an odd document, a DB hiccup) must not lose the rest of the batch.
          stats.errors += 1;
          logger.warn("TokenSage item not stored", { mint: item.ca, error: (err as Error).message });
        }
      }
    }
  }
}

/**
 * A mint's previous job ended without an analysis. A definitive failure (not a token mint, not a
 * pump.fun coin) is cached so it is never asked again - otherwise every re-send would start a new
 * job, and at full depth each one costs a unit of the daily quota. A mint not on-chain yet is
 * left alone past TokenSage's 10-minute failure window. Anything else keeps the new job.
 */
async function checkEndedJob(
  api: TokenSageClient,
  mint: string,
  p: Pending,
  endedJobId: number,
): Promise<void> {
  try {
    const job = await api.job(endedJobId);
    if (job.status !== "failed") return;
    const code = String(job.error ?? "")
      .split(":")[0]!
      .trim();
    if (code === "token_not_found" || DEFINITIVE_FAILURES.includes(code)) {
      await noteFailure(mint, p.depth, job.error);
    }
  } catch (err) {
    logger.warn("TokenSage job lookup failed", { error: String(err) });
  }
}
