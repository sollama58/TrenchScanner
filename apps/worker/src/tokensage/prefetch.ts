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
} from "@trenchscanner/core";
import type { Prisma } from "@prisma/client";

const logger = createLogger("tokensage");

/**
 * Asks TokenSage what each candidate is about and stores the answer in TokenNarrative.
 *
 * The scan notes the mints it wants (noteNarrativeWanted): basic depth the first time a mint
 * passes the rug screen inside the curated band, full depth (which also reads the X link and
 * trends) when the mint gets a decision ("event") row. At the end of each cycle
 * flushNarrativeRequests sends them in batches and is never awaited: nothing in the scan,
 * matching or alerting path waits on TokenSage. A batch answers cached mints at once and queues
 * the rest; queued ones are polled by job id on later cycles (polling is free, while re-sending a
 * full-depth mint would count against TokenSage's daily quota again).
 *
 * Failures cost only the narrative: a 429 or 503 pauses requests for a minute, a mint TokenSage
 * can't analyse is cached as "failed" so it isn't asked again, and a job that never finishes is
 * dropped after JOB_GIVE_UP_MS. Everything here is in-process, so a restart forgets the queue
 * and the day's full-depth count; mints still in band are noted again on the next scan.
 */

/** Polls per flush; with two batches a cycle this stays well under TokenSage's 60/min per key. */
const MAX_POLLS_PER_FLUSH = 10;
const JOB_GIVE_UP_MS = 5 * 60_000;
const PAUSE_AFTER_REFUSAL_MS = 60_000;
/** Mints noted but not yet sent are kept at most this many (newest win). */
const MAX_WANTED = 2_000;

interface PendingJob {
  jobId: number;
  depth: TokenSageDepth;
  since: number;
}

const wanted = new Map<string, TokenSageDepth>();
/** Mints already stored at a depth (or cached as failed), so the scan's per-cycle notes are free. */
const settled = new Map<string, TokenSageDepth>();
const MAX_SETTLED = 20_000;
const pending = new Map<string, PendingJob>();
let flushing = false;
let pausedUntil = 0;
let fullDay = "";
let fullSentToday = 0;

interface Stats {
  requested: number;
  stored: number;
  failed: number;
  errors: number;
}
let stats: Stats = { requested: 0, stored: 0, failed: 0, errors: 0 };

/** Test hook. */
export function resetTokenSage(): void {
  wanted.clear();
  settled.clear();
  pending.clear();
  flushing = false;
  pausedUntil = 0;
  fullDay = "";
  fullSentToday = 0;
  stats = { requested: 0, stored: 0, failed: 0, errors: 0 };
}

export function tokenSageEnabled(env: Env): boolean {
  return env.TOKENSAGE_ENABLED && env.TOKENSAGE_API_URL !== "" && env.TOKENSAGE_API_KEY !== "";
}

/** Notes that the scan wants this mint's narrative at `depth`. Cheap; does no IO. */
export function noteNarrativeWanted(mintAddress: string, depth: TokenSageDepth, env: Env): void {
  if (!tokenSageEnabled(env)) return;
  if (narrativeDepthCovers(settled.get(mintAddress), depth)) return;
  const have = wanted.get(mintAddress);
  if (have === "full") return;
  if (!have && wanted.size >= MAX_WANTED) {
    const oldest = wanted.keys().next().value;
    if (oldest !== undefined) wanted.delete(oldest);
  }
  wanted.set(mintAddress, depth);
}

/** Counters since the last read, for the scan cycle's summary on /health/worker. */
export function takeTokenSageStats(): Record<string, number> {
  const out = { ...stats, waiting: wanted.size, pending: pending.size, fullToday: fullSentToday };
  stats = { requested: 0, stored: 0, failed: 0, errors: 0 };
  return out;
}

function settle(mintAddress: string, depth: TokenSageDepth): void {
  if (settled.size >= MAX_SETTLED) settled.clear();
  settled.set(mintAddress, depth);
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
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
  // A basic answer that lands after a full one must not overwrite it.
  if (
    existing &&
    existing.status !== "failed" &&
    !narrativeDepthCovers(fields.depth, existing.depth as TokenSageDepth)
  ) {
    return;
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
  settle(analysis.mint, fields.depth);
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
  settle(mintAddress, "full");
}

/**
 * Sends what the scan noted and polls what TokenSage queued. Call without awaiting; a flush
 * already running makes this a no-op. Resolves when done, for tests.
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
    await pollPending(api, now);
    await sendWanted(api, env, now);
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

async function pollPending(api: TokenSageClient, now: number): Promise<void> {
  const due = [...pending.entries()].sort((a, b) => a[1].since - b[1].since).slice(0, MAX_POLLS_PER_FLUSH);
  for (const [mint, job] of due) {
    if (now - job.since > JOB_GIVE_UP_MS) {
      pending.delete(mint);
      stats.errors += 1;
      continue;
    }
    const res = await api.job(job.jobId);
    if (res.status === "done") {
      pending.delete(mint);
      const analysis = res.result?.analysis;
      if (analysis) {
        const partial = (analysis.caveats ?? []).some((c) => String(c).startsWith("partial:"));
        await storeAnalysis(analysis, partial ? "partial" : "complete");
      }
    } else if (res.status === "failed") {
      pending.delete(mint);
      // token_not_found on a seconds-old mint can clear up; anything else is definitive.
      if (!String(res.error ?? "").startsWith("token_not_found")) await storeFailure(mint, job.depth);
    }
  }
}

async function sendWanted(api: TokenSageClient, env: Env, now: number): Promise<void> {
  if (wanted.size === 0 || env.TOKENSAGE_MAX_BATCHES_PER_CYCLE === 0) return;
  const day = utcDay(now);
  if (day !== fullDay) {
    fullDay = day;
    fullSentToday = 0;
  }

  // Drop what's already stored deep enough, or already queued on TokenSage's side.
  const mints = [...wanted.keys()];
  const stored = await prisma.tokenNarrative.findMany({
    where: { mintAddress: { in: mints } },
    select: { mintAddress: true, depth: true, status: true },
  });
  const storedByMint = new Map(stored.map((r) => [r.mintAddress, r]));
  const byDepth: Record<TokenSageDepth, string[]> = { full: [], basic: [] };
  for (const [mint, depth] of wanted) {
    const row = storedByMint.get(mint);
    const covered = row && (row.status === "failed" || narrativeDepthCovers(row.depth, depth));
    const queued = pending.get(mint);
    if (covered || (queued && narrativeDepthCovers(queued.depth, depth))) {
      if (covered) settle(mint, row.status === "failed" ? "full" : (row.depth as TokenSageDepth));
      wanted.delete(mint);
      continue;
    }
    byDepth[depth].push(mint);
  }

  // Full first: those are the mints a model is deciding on right now.
  let batches = env.TOKENSAGE_MAX_BATCHES_PER_CYCLE;
  for (const depth of ["full", "basic"] as const) {
    let list = byDepth[depth];
    if (depth === "full") list = list.slice(0, Math.max(0, env.TOKENSAGE_FULL_PER_DAY - fullSentToday));
    while (list.length > 0 && batches > 0) {
      const chunk = list.slice(0, TOKENSAGE_BATCH_MAX);
      list = list.slice(TOKENSAGE_BATCH_MAX);
      batches -= 1;
      const items = await api.batch(chunk, depth);
      stats.requested += chunk.length;
      if (depth === "full") fullSentToday += chunk.length;
      for (const mint of chunk) wanted.delete(mint);
      for (const item of items) {
        if ((item.status === "complete" || item.status === "partial") && item.analysis) {
          await storeAnalysis(item.analysis, item.status);
        } else if (item.status === "pending" && typeof item.job_id === "number") {
          pending.set(item.ca, { jobId: item.job_id, depth, since: Date.now() });
        } else if (item.status === "invalid" || item.status === "failed") {
          await storeFailure(item.ca, depth);
        }
      }
    }
  }
}
