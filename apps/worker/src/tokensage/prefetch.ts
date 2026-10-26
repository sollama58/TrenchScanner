import {
  prisma,
  createLogger,
  HttpError,
  TokenSageClient,
  TOKENSAGE_PREFETCH_CHUNK,
  basicXRetryable,
  narrativeDepthCovers,
  narrativeFieldsFromAnalysis,
  storableAnalysis,
  tokenSageEnabled,
  tokenSageImageUrl,
  tokenSageReadIsStale,
  tokenSageSocials,
  type Env,
  type TokenSageAnalysis,
  type TokenSageDepth,
  type TokenSageHints,
  type TokenSagePriority,
} from "@trenchscanner/core";
import { Prisma } from "@prisma/client";
import { forgetNarrativeRead } from "./heldNarrativeReads.js";
import { flushNowReads } from "./nowReads.js";
import { recordSocialLinks } from "../jobs/socialsFill.js";

const logger = createLogger("tokensage");

/**
 * Asks TokenSage what each candidate is about and stores the answer in TokenNarrative.
 *
 * The scan notes the mints it wants (noteNarrativeWanted), with what discovery already knows
 * about them as hints: basic depth the first time a mint passes the rug screen on the watchlist
 * (any scanned mint, in band or still below it, so the read is usually stored before the band
 * entry that most first decisions follow within a minute). From rules 0.36.0 that basic read
 * interprets the linked post or profile text. Full depth (the X match, account credibility,
 * trends, and quoted or replied posts) is still asked when the mint gets a decision ("event")
 * row, and for a young coin with an X link, in the same flush as the basic read rather than
 * instead of it (no daily cap of our own since 2026-10-11, user decision). startNarrativePolling
 * re-sends what is queued between cycles. At the end of each cycle flushNarrativeRequests
 * sends them in batches and is never awaited: nothing in the scan, matching or alerting path
 * waits on TokenSage. A batch answers cached mints at once and queues the rest; a queued mint is
 * simply re-sent in the next cycle's batch, which joins its open job for free and returns the
 * analysis once done. That keeps us to a couple of requests a cycle, far inside TokenSage's
 * 60/min per key, where polling each job would not be.
 *
 * Every request carries a priority tier (narrativePriority), which orders both our own sends and
 * TokenSage's job queue: the reads for coins that passed the screen (quick and deep) ahead of the
 * first-scan reads asked before a coin's first screen verdict. On 2026-10-15, with the Jupiter
 * discovery sources, TokenSage served every request oldest first at one priority: a decision's
 * deep read took 45 s at the median instead of 4 s, and the share of decisions carrying any read
 * fell from ~85% to ~45%. A first-scan read is raised to the normal tier when the coin passes the
 * screen, by re-sending it at that tier. (Until 2026-10-20 the low tier was a read for every
 * launch discovery saw, ~1,900 an hour; that backlog filled TokenSage's queue.)
 *
 * Failures cost only the narrative:
 * - a 429 or 503 on the whole batch pauses requests for a minute;
 * - an item turned away for quota or load is re-sent later, and once the day's full-depth quota
 *   is spent on TokenSage's side (X-Quota-Full-Remaining, or an item answered quota_exceeded)
 *   full requests fall back to basic until midnight UTC. We keep no daily cap of our own;
 * - a mint TokenSage can't analyse is cached as "failed" so it isn't asked again;
 * - a partial answer (an upstream source failed, or the mint isn't on-chain yet) is stored and
 *   asked again a little later, a few times (from rules 0.28.0 metadata that never resolves ends
 *   as complete with the metadata_unresolved flag, not partial for good);
 * - a mint still pending after PENDING_GIVE_UP_MS is dropped.
 * Everything here is in-process, so a restart forgets the queue and the day's count; mints still
 * on the watchlist are noted again on the next scan.
 */

/**
 * At least NOT_FOUND_COOLDOWN_MS: TokenSage answers a mint with its failed job for up to 10
 * minutes after that job failed, so a pending entry dropped sooner would only be asked again
 * into the same answer.
 */
const PENDING_GIVE_UP_MS = 11 * 60_000;
const PAUSE_AFTER_REFUSAL_MS = 60_000;
/** A rejected key (401/403) won't fix itself between polls: ask again only this often. */
const PAUSE_AFTER_AUTH_FAILURE_MS = 5 * 60_000;
/** TokenSage caches a partial answer for 60 s; ask again after that, at most this many times. */
const PARTIAL_RETRY_MS = 90_000;
const PARTIAL_MAX_RETRIES = 3;
/** Mints noted but not yet sent are kept at most this many (oldest dropped). */
const MAX_WANTED = 2_000;
/**
 * A basic read noted and not sent within this long is dropped. The scan notes its watchlist mints
 * every cycle, so what goes stale is a launch read or a coin that left the watchlist: after a pause
 * or a backlog, those were the first requests sent, for coins nothing would read.
 */
const WANTED_BASIC_MAX_AGE_MS = 10 * 60_000;
const MAX_SETTLED = 20_000;

interface Wanted {
  depth: TokenSageDepth;
  priority: TokenSagePriority;
  hints?: TokenSageHints;
  /** A full read asked early (a young coin with an X link), on its own daily budget. */
  early?: boolean;
  /** When the scan last noted it (see WANTED_BASIC_MAX_AGE_MS). */
  notedAt: number;
  /**
   * A basic read noted and not yet sent, kept when the same mint is upgraded to full before the
   * flush. Rules 0.36.0: the basic read is the fast narrative; full still runs for the match.
   */
  alsoBasic?: boolean;
  basicPriority?: TokenSagePriority;
  /** notedAt of that basic read, so the upgrade does not refresh its drop window. */
  basicNotedAt?: number;
}

interface Pending {
  depth: TokenSageDepth;
  priority: TokenSagePriority;
  hints?: TokenSageHints;
  since: number;
  jobId?: number;
}

interface Settled {
  depth: TokenSageDepth;
  /** Set while a partial answer may still be asked again: when, and how many times so far. */
  partialAt?: number;
  partialTries?: number;
  /**
   * A complete basic read whose tweet text was not fetched. Asked again at xRetryAt, xRetries
   * times so far, then left. The cache may fill from another coin on the same post.
   */
  xRetryAt?: number;
  xRetries?: number;
}

/** How long to wait before asking again for a tweet TokenSage did not fetch, and how many times. */
const BASIC_X_RETRY_MS = 2 * 60_000;
const BASIC_X_MAX_RETRIES = 2;

const wanted = new Map<string, Wanted>();
const pending = new Map<string, Pending>();
/** Mints already stored at a depth (or cached as failed), so the scan's per-cycle notes are free. */
const settled = new Map<string, Settled>();
/**
 * Mints whose last analysis failed without a definitive reason (or that weren't on-chain yet),
 * left alone until the time stored. TokenSage answers any request within 10 minutes of a failed
 * job with that failure, so asking sooner only wastes a request.
 */
const notFoundUntil = new Map<string, number>();
const NOT_FOUND_COOLDOWN_MS = 11 * 60_000;
/** Entries are only deleted when their mint is asked for again, so expired ones are swept here. */
function rememberNotFound(mint: string, until: number): void {
  if (notFoundUntil.size >= 5_000) {
    const now = Date.now();
    for (const [m, t] of notFoundUntil) if (t <= now) notFoundUntil.delete(m);
    if (notFoundUntil.size >= 5_000) notFoundUntil.clear();
  }
  notFoundUntil.set(mint, until);
}
/** Transient failures per mint; after this many it is cached as failed like a definitive one. */
const failCounts = new Map<string, number>();
const MAX_TRANSIENT_FAILURES = 3;
/** Old-job lookups per flush (see checkEndedJob). */
const MAX_JOB_CHECKS_PER_FLUSH = 5;
/**
 * "worker died" (rules 0.28.0): TokenSage's worker crashed on this mint job_max_attempts times
 * already, so asking again would only crash it again, at a unit of full quota each time.
 */
const DEFINITIVE_FAILURES = ["not_a_token_mint", "not_pumpfun", "invalid_ca", "worker died", "worker_died"];
let flushing = false;
/**
 * The longest one flush may hold the flushing flag. Every request in it has its own timeout, but
 * on 2026-10-08 a flush never returned (a request or query that never settled) and, with the
 * flag held, every later flush was a no-op: nothing reached TokenSage for an hour, with no error
 * logged, until a restart. Past this the flag is released and the next flush goes ahead; the
 * stuck one is abandoned (whatever it still finishes is harmless: a stored read, a map entry).
 */
export const FLUSH_DEADLINE_MS = 2 * 60_000;
let flushDeadlineMs = FLUSH_DEADLINE_MS;
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
  /** Queued mints dropped after PENDING_GIVE_UP_MS without an answer (TokenSage never finished them). */
  givenUp: number;
  /** Flushes abandoned at FLUSH_DEADLINE_MS. */
  hung: number;
  /** HTTP status of the last request TokenSage refused or failed this cycle (0: none). */
  lastStatus: number;
}
const NO_STATS: Stats = {
  requested: 0,
  stored: 0,
  failed: 0,
  turnedAway: 0,
  errors: 0,
  givenUp: 0,
  hung: 0,
  lastStatus: 0,
};
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
  flushDeadlineMs = FLUSH_DEADLINE_MS;
  stats = { ...NO_STATS };
}

/** Test hook: a shorter flush deadline. */
export function setFlushDeadlineForTest(ms: number): void {
  flushDeadlineMs = ms;
}

export { tokenSageEnabled };

function settledCovers(mintAddress: string, depth: TokenSageDepth, now: number): boolean {
  const s = settled.get(mintAddress);
  if (!s || !narrativeDepthCovers(s.depth, depth)) return false;
  // A basic read whose tweet text never arrived is asked again once the retry is due.
  if (depth === "basic" && s.xRetryAt !== undefined && now >= s.xRetryAt) return false;
  // A partial answer is worth asking for again once TokenSage would re-analyse it.
  if (s.partialAt !== undefined && now - s.partialAt >= PARTIAL_RETRY_MS) {
    return (s.partialTries ?? 0) >= PARTIAL_MAX_RETRIES;
  }
  return true;
}

const PRIORITY_RANK: Record<TokenSagePriority, number> = { high: 0, normal: 1, low: 2 };
const PRIORITY_TIERS: TokenSagePriority[] = ["high", "normal", "low"];

/** The more urgent of two tiers. */
function higher(a: TokenSagePriority, b: TokenSagePriority | undefined): TokenSagePriority {
  return b !== undefined && PRIORITY_RANK[b] < PRIORITY_RANK[a] ? b : a;
}

/**
 * A request's tier: the first-scan read (asked before the coin's first screen verdict) low, every
 * other read normal. Deep reads went in "high" at first, ahead of every quick read, but a deep read can hold one of TokenSage's analyzer slots
 * for minutes (X, OCR): on 2026-10-16 from 01:10 UTC the deep reads filled every slot and quick
 * reads stopped completing altogether (250+ queued, none stored). At one tier they share the
 * slots oldest first, as before priorities existed, and only the first-scan reads yield.
 *
 * The one read in "high" is the quick read asked at a band crossing (requestNarrativeRead): the
 * fast path holds that coin's decision for it (entryFastPath.ts), so it goes ahead of the deep
 * reads and the refreshes nothing waits on. It is a basic read, seconds of a slot, and there are
 * tens an hour, so it cannot starve the normal tier the way the deep reads did.
 */
export function narrativePriority(_depth: TokenSageDepth, firstScan = false): TokenSagePriority {
  return firstScan ? "low" : "normal";
}

/**
 * Notes that the scan wants this mint's narrative at `depth`. Cheap; does no IO. `priority`
 * names the tier outright (the crossing read); otherwise narrativePriority decides.
 */
export function noteNarrativeWanted(
  mintAddress: string,
  depth: TokenSageDepth,
  env: Env,
  hints?: TokenSageHints,
  opts: { early?: boolean; firstScan?: boolean; priority?: TokenSagePriority } = {},
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
  const tier = opts.priority ?? narrativePriority(depth, opts.firstScan);
  const early = depth === "full" && opts.early === true;
  // A queued deep read is never downgraded: a decision-row full read outranks an early one (it
  // isn't held to the early budget). A basic note can still raise the basic read riding along
  // with that full one, and refresh its drop window: the scan asked for it again.
  if (have?.depth === "full" && (depth === "basic" || !have.early || early)) {
    if (depth === "basic" && have.alsoBasic) {
      have.basicPriority = higher(tier, have.basicPriority);
      have.basicNotedAt = now;
      if (hints) have.hints = hints;
    }
    return;
  }
  if (!have && wanted.size >= MAX_WANTED) {
    const oldest = wanted.keys().next().value;
    if (oldest !== undefined) wanted.delete(oldest);
  }
  const keepBasic = depth === "full" && (have?.depth === "basic" || have?.alsoBasic === true);
  wanted.set(mintAddress, {
    depth,
    // A coin noted at its first scan and again on a screen pass keeps the pass's tier.
    priority: higher(tier, have?.depth === depth ? have.priority : undefined),
    hints: hints ?? have?.hints,
    ...(early ? { early } : {}),
    ...(keepBasic
      ? {
          alsoBasic: true,
          basicPriority: have?.depth === "basic" ? have.priority : (have?.basicPriority ?? "normal"),
          basicNotedAt: have?.basicNotedAt ?? have?.notedAt ?? now,
        }
      : {}),
    notedAt: depth === "basic" ? now : (have?.notedAt ?? now),
  });
}

/**
 * Whether TokenSage has answered for this mint, one way or the other: a read stored at some depth
 * (settle), or a failure cached as not found. The entry fast path's hold (entryFastPath.ts) waits
 * on this: once it is true nothing more is coming for the quick read, so the decision can go.
 * Only this process's own stores count (the scanner's prefetcher is the one writer).
 */
export function narrativeSettled(mintAddress: string, now = Date.now()): boolean {
  if (settled.has(mintAddress)) return true;
  const cooling = notFoundUntil.get(mintAddress);
  return cooling !== undefined && now < cooling;
}

/**
 * Asks for a mint's quick read now: noted at the high tier and flushed at once rather than on the
 * next poll, so the request is at the front of TokenSage's queue within the second. The entry
 * watch calls this the moment a launch first reads at or over the floor (entryWatch.ts
 * onCrossing), a few seconds before the fast path holds its decision for the read
 * (entryFastPath.ts), so the read is most of the way back by then. `hints` is what discovery
 * already knows about the coin (tokenSageHints), which spares TokenSage its own metadata fetch.
 * A flush already running makes the kick a no-op; the poller re-sends the note on its next tick.
 */
export function requestNarrativeRead(
  mintAddress: string,
  env: Env,
  client?: TokenSageClient,
  hints?: TokenSageHints,
): void {
  if (!tokenSageEnabled(env)) return;
  noteNarrativeWanted(mintAddress, "basic", env, hints, { priority: "high" });
  if (wanted.has(mintAddress)) void flushNarrativeRequests(env, client);
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
    // The decision-time refreshes ride the same timer: a new one is ready seconds after it was
    // asked for, not a scan cycle later (nowReads.ts; a no-op when nothing is due).
    void flushNowReads(env, client);
    // A tweet-text retry lives on the settled map until it is due, with nothing queued.
    if (pending.size === 0 && wanted.size === 0 && !basicXRetryDue()) return;
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
    // Seconds left on a pause after a refusal (429/503, an overloaded item, a rejected key).
    pausedForS: Math.max(0, Math.ceil((pausedUntil - Date.now()) / 1000)),
    fullBlocked: Date.now() < fullBlockedUntil ? 1 : 0,
  };
  stats = { ...NO_STATS };
  return out;
}

function settle(mintAddress: string, depth: TokenSageDepth, partial: boolean): void {
  if (settled.size >= MAX_SETTLED) settled.clear();
  const prev = settled.get(mintAddress);
  const next: Settled = partial
    ? { depth, partialAt: Date.now(), partialTries: (prev?.partialTries ?? 0) + (prev?.partialAt ? 1 : 0) }
    : { depth };
  // A full read closes the basic X retry. A basic store keeps the count so the next schedule
  // does not start it over.
  if (depth !== "full" && prev?.xRetries !== undefined) next.xRetries = prev.xRetries;
  if (depth !== "full" && prev?.xRetryAt !== undefined) next.xRetryAt = prev.xRetryAt;
  settled.set(mintAddress, next);
}

/** Ask again later for a basic read whose tweet text was not fetched, up to BASIC_X_MAX_RETRIES. */
function scheduleBasicXRetry(mint: string): void {
  const s = settled.get(mint);
  if (!s || s.depth === "full") return;
  const tries = (s.xRetries ?? 0) + 1;
  s.xRetries = tries;
  if (tries > BASIC_X_MAX_RETRIES) {
    delete s.xRetryAt;
    return;
  }
  s.xRetryAt = Date.now() + BASIC_X_RETRY_MS;
}

function clearBasicXRetry(mint: string): void {
  const s = settled.get(mint);
  if (!s) return;
  delete s.xRetryAt;
  delete s.xRetries;
}

/**
 * A basic read whose tweet text was not fetched, due for another try, and not already noted.
 * Low tier: it must not cut in front of a screen-pass read. A full read already noted keeps its
 * place and carries the basic retry beside it.
 */
function basicXRetryDue(now = Date.now()): boolean {
  for (const s of settled.values()) {
    if (s.depth !== "full" && s.xRetryAt !== undefined && now >= s.xRetryAt) return true;
  }
  return false;
}

function queueDueBasicXRetries(now: number): void {
  for (const [mint, s] of settled) {
    if (s.xRetryAt === undefined || now < s.xRetryAt || s.depth === "full") continue;
    if ((s.xRetries ?? 0) > BASIC_X_MAX_RETRIES) {
      delete s.xRetryAt;
      continue;
    }
    if (pending.has(mint)) continue;
    const have = wanted.get(mint);
    if (have?.depth === "full") {
      if (!have.alsoBasic) {
        have.alsoBasic = true;
        have.basicPriority = "low";
        have.basicNotedAt = now;
      }
      continue;
    }
    if (have?.depth === "basic") continue;
    if (wanted.size >= MAX_WANTED) continue;
    wanted.set(mint, { depth: "basic", priority: "low", notedAt: now });
  }
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
    select: { depth: true, status: true, analyzedAt: true },
  });
  // A shallower answer that lands after a deeper one must not overwrite it, and neither may a
  // partial answer overwrite a complete one at the same depth. An older analysis at the same
  // depth (a cached copy, past clock skew) must not replace the one we already stored.
  if (existing && existing.status !== "failed") {
    const deeper = !narrativeDepthCovers(fields.depth, existing.depth as TokenSageDepth);
    const worse = existing.depth === fields.depth && existing.status === "complete" && status === "partial";
    const stale =
      existing.depth === fields.depth && tokenSageReadIsStale(fields.analyzedAt, existing.analyzedAt);
    if (deeper || worse || stale) {
      settle(mint, existing.depth as TokenSageDepth, false);
      if (deeper) clearBasicXRetry(mint);
      else if (stale && basicXRetryable(analysis)) scheduleBasicXRetry(mint);
      else if (stale) clearBasicXRetry(mint);
      return;
    }
  }
  // The raw document is kept only where something will show it: full reads (asked for coins in
  // the band) and basic reads of coins that have reached the band. A basic read of a launch that
  // never gets there is 94% of rows and most of the table's bytes (db-size-audit-2026-10-14), and
  // only the derived columns of those are ever read. If the coin enters the band later, the full
  // read asked then brings its document.
  const keepDocument = fields.depth === "full" || (await tokenInBand(mint));
  const data = {
    ...fields,
    categories: fields.categories as unknown as Prisma.InputJsonValue,
    failReason: null,
    analysis: keepDocument ? ((storableAnalysis(analysis) ?? {}) as Prisma.InputJsonValue) : Prisma.DbNull,
    checkedAt: new Date(),
  };
  await prisma.tokenNarrative.upsert({
    where: { mintAddress: mint },
    create: { mintAddress: mint, ...data },
    update: data,
  });
  forgetNarrativeRead(mint);
  stats.stored += 1;
  failCounts.delete(mint);
  settle(mint, fields.depth, status === "partial");
  if (status === "complete" && fields.depth === "basic" && basicXRetryable(analysis)) {
    scheduleBasicXRetry(mint);
  } else {
    clearBasicXRetry(mint);
  }
  if (fields.depth === "basic" && fields.referentSupport.includes("x")) {
    logger.info("TokenSage basic read names its referent from X", {
      mint,
      postId: fields.referentPostId,
      relation: fields.xRelation,
    });
  }
  const caveats = Array.isArray(analysis.caveats)
    ? analysis.caveats.filter((c): c is string => typeof c === "string" && c.startsWith("basic x:"))
    : [];
  if (caveats.length > 0) {
    logger.info("TokenSage basic X caveat", { mint, caveats });
  }
  await backfillTokenImage(mint, analysis);
  // The links TokenSage's own metadata read found, on a row still missing them (socialsFill.ts).
  await recordSocialLinks([{ mintAddress: mint, ...tokenSageSocials(analysis) }]).catch((err: unknown) =>
    logger.warn("token socials backfill failed", { mint, error: String(err) }),
  );
}

/**
 * A coin with no artwork on its Token row takes the logo TokenSage resolved for it. TokenSage
 * owns the metadata lookup for every coin it reads, so nothing here fetches anything: the
 * dashboard, alerts and Telegram reuse what it found. Only rows still missing an image are
 * touched, so a Pump.fun image already stored is never replaced.
 */
async function backfillTokenImage(mintAddress: string, analysis: TokenSageAnalysis): Promise<void> {
  const imageUrl = tokenSageImageUrl(analysis);
  if (!imageUrl) return;
  await prisma.token
    .updateMany({ where: { mintAddress, imageUrl: null }, data: { imageUrl } })
    .catch((err) => logger.warn("token image backfill failed", { mint: mintAddress, error: String(err) }));
}

/** Whether the coin has ever been in the curated band (Token.firstInBandAt); false with no Token row. */
async function tokenInBand(mintAddress: string): Promise<boolean> {
  const token = await prisma.token.findUnique({ where: { mintAddress }, select: { firstInBandAt: true } });
  return token?.firstInBandAt != null;
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
  forgetNarrativeRead(mintAddress);
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
  // Matched by prefix: a batch item's error is "<code>: <detail>", and an older TokenSage sent
  // a dead worker as "worker died; retried automatically after ..." with no colon at all.
  const head = reason.trim().toLowerCase();
  const tries = (failCounts.get(mint) ?? 0) + 1;
  if (DEFINITIVE_FAILURES.some((c) => head.startsWith(c)) || tries >= MAX_TRANSIENT_FAILURES) {
    await storeFailure(mint, depth, reason);
    return;
  }
  if (failCounts.size >= 5_000) failCounts.clear();
  failCounts.set(mint, tries);
  rememberNotFound(mint, Date.now() + NOT_FOUND_COOLDOWN_MS);
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
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      send(api, env, now),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new FlushHung()), flushDeadlineMs);
        deadline.unref();
      }),
    ]);
  } catch (err) {
    stats.errors += 1;
    if (err instanceof HttpError) stats.lastStatus = err.status;
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      pausedUntil = Date.now() + PAUSE_AFTER_AUTH_FAILURE_MS;
      logger.warn("TokenSage rejected TOKENSAGE_API_KEY; pausing 5 minutes", { status: err.status });
    } else if (err instanceof FlushHung) {
      stats.hung += 1;
      logger.error("TokenSage flush did not finish; abandoning it so the next one can run", {
        deadlineMs: flushDeadlineMs,
      });
    } else if (isRefusal(err)) {
      pausedUntil = Date.now() + PAUSE_AFTER_REFUSAL_MS;
      logger.warn("TokenSage refused requests; pausing", { status: (err as HttpError).status });
    } else {
      logger.warn("TokenSage flush failed", { error: String(err) });
    }
  } finally {
    clearTimeout(deadline);
    flushing = false;
  }
}

class FlushHung extends Error {}

async function send(api: TokenSageClient, env: Env, now: number): Promise<void> {
  if (env.TOKENSAGE_MAX_BATCHES_PER_CYCLE === 0) return;
  const day = utcDay(now);
  if (day !== fullDay) {
    fullDay = day;
    fullSentToday = 0;
    earlySentToday = 0;
  }
  const fullOpen = now >= fullBlockedUntil;

  // Queued on TokenSage's side: re-sent (free) until they finish or we give up on them, a chunk at
  // a time alternating with new requests (see interleave).
  type Entry = { ca: string; hints?: TokenSageHints; priority: TokenSagePriority };
  const resend: Record<TokenSageDepth, Entry[]> = { full: [], basic: [] };
  const byDepth: Record<TokenSageDepth, Entry[]> = { full: [], basic: [] };
  for (const [mint, p] of pending) {
    if (now - p.since > PENDING_GIVE_UP_MS) {
      pending.delete(mint);
      stats.errors += 1;
      stats.givenUp += 1;
      continue;
    }
    if (p.depth === "full" && !fullOpen) continue;
    resend[p.depth].push({ ca: mint, hints: p.hints, priority: p.priority });
  }

  // A basic read whose tweet was not fetched, due again between scans.
  queueDueBasicXRetries(now);

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
  const earlyMints = new Set<string>();
  for (const [mint, w] of wanted) {
    if (w.depth === "basic" && now - w.notedAt > WANTED_BASIC_MAX_AGE_MS) {
      wanted.delete(mint);
      continue;
    }
    if (w.alsoBasic && w.basicNotedAt !== undefined && now - w.basicNotedAt > WANTED_BASIC_MAX_AGE_MS) {
      w.alsoBasic = false;
    }
    const queued = pending.get(mint);
    if (queued && narrativeDepthCovers(queued.depth, w.depth)) {
      // Asked for at a higher tier than it was queued at (a launch read the scan now wants):
      // re-sent at that tier, which raises the open job on TokenSage's side.
      const raised = higher(queued.priority, w.priority);
      if (raised !== queued.priority) {
        queued.priority = raised;
        const r = resend[queued.depth].find((e) => e.ca === mint);
        if (r) r.priority = raised;
      }
      wanted.delete(mint);
      continue;
    }
    const row = storedByMint.get(mint);
    const xDue = w.depth === "basic" && (settled.get(mint)?.xRetryAt ?? Number.POSITIVE_INFINITY) <= now;
    if (!xDue && row && (row.status === "failed" || narrativeDepthCovers(row.depth, w.depth))) {
      // A partial answer the scan asked for again (settledCovers let it through) is re-sent.
      const retryPartial = row.status === "partial" && settled.get(mint)?.partialAt !== undefined;
      if (!retryPartial) {
        if (!settled.has(mint))
          settle(mint, row.status === "failed" ? "full" : (row.depth as TokenSageDepth), false);
        wanted.delete(mint);
        continue;
      }
    }
    // No daily cap of our own (user decision 2026-10-11): every deep read the scan asks for is
    // sent, unless TokenSage itself has said its full quota is spent for the day.
    const basicEntry = (): Entry => ({
      ca: mint,
      hints: w.hints,
      priority: w.basicPriority ?? w.priority,
    });
    if (w.depth === "full" && fullOpen) {
      if (w.early) earlyMints.add(mint);
      byDepth.full.push({ ca: mint, hints: w.hints, priority: w.priority });
      // The basic read noted before this upgrade still goes out: it is the fast narrative.
      if (w.alsoBasic) byDepth.basic.push(basicEntry());
    } else if (w.early) {
      // TokenSage's full quota is spent: the basic read, as for any other coin, unless one is on
      // its way.
      if (queued || row) wanted.delete(mint);
      else
        byDepth.basic.push(w.alsoBasic ? basicEntry() : { ca: mint, hints: w.hints, priority: w.priority });
    } else if (queued || (w.depth === "full" && row && row.status !== "failed")) {
      // TokenSage's full quota is spent, with a basic answer stored or on its way: the full
      // request stays noted for when the quota is back. A basic read not yet sent still goes.
      const basicStored =
        row !== undefined && row.status !== "failed" && narrativeDepthCovers(row.depth, "basic");
      if (w.alsoBasic && !queued && !basicStored) byDepth.basic.push(basicEntry());
      continue;
    } else {
      byDepth.basic.push({ ca: mint, hints: w.hints, priority: w.priority });
    }
  }

  // Youngest coins first: a read only helps a decision it lands before, and most first decisions
  // come within a few minutes of launch. In a backlog, first-noted-first-sent leaves a new launch
  // behind hundreds of older requests until it has already been decided (2026-10-08: with 200+
  // reads waiting each cycle, under-3-minute first decisions carrying any read fell from ~95% to
  // under 5%).
  newestFirst(byDepth.full);
  newestFirst(byDepth.basic);
  // The depths take batches in turn, full first (those are the mints a model is deciding on
  // right now). Full taking every batch until its list ran dry let a full-depth backlog starve
  // the quick reads entirely. Within a depth, tier by tier: a backlog of queued launch reads
  // re-sent every flush used to fill the quick-read batch, so a watchlist coin's read waited
  // behind it on our side as well as TokenSage's (2026-10-15: 35 waiting behind 38 queued).
  const lists: Record<TokenSageDepth, Entry[]> = {
    full: byTier(resend.full, byDepth.full),
    basic: byTier(resend.basic, byDepth.basic),
  };
  // Halves of a refused chunk (see the 404/422 below), sent before anything else and outside
  // the batch budget: a refused request starts no job, and splitting has to finish within the
  // flush, or the next one would build the same chunk and be refused again.
  const splits: Record<TokenSageDepth, Entry[][]> = { full: [], basic: [] };
  let batches = env.TOKENSAGE_MAX_BATCHES_PER_CYCLE;
  let jobChecks = MAX_JOB_CHECKS_PER_FLUSH;
  let turn: TokenSageDepth = "full";
  for (;;) {
    const split: TokenSageDepth | null =
      splits.full.length > 0 ? "full" : splits.basic.length > 0 ? "basic" : null;
    let depth: TokenSageDepth;
    let chunk: Entry[];
    if (split) {
      depth = split;
      chunk = splits[split].shift()!;
    } else {
      if (batches <= 0 || (lists.full.length === 0 && lists.basic.length === 0)) break;
      depth = lists[turn].length > 0 ? turn : turn === "full" ? "basic" : "full";
      turn = depth === "full" ? "basic" : "full";
      chunk = lists[depth].slice(0, TOKENSAGE_PREFETCH_CHUNK);
      lists[depth] = lists[depth].slice(TOKENSAGE_PREFETCH_CHUNK);
      batches -= 1;
    }
    let result;
    try {
      result = await api.batch(chunk, depth);
    } catch (err) {
      if (!(err instanceof HttpError) || (err.status !== 404 && err.status !== 422)) throw err;
      // TokenSage answers a definitive failure (token_not_found, not_pumpfun, ...) as that
      // item's own status, so a whole batch refused 404/422 means one entry failed validation
      // (a hint past its limits). The chunk is split and the halves sent ahead, so the other
      // mints still go through and the offending one ends up alone; only it is left out.
      stats.errors += 1;
      stats.lastStatus = err.status;
      if (chunk.length > 1) {
        const half = Math.ceil(chunk.length / 2);
        splits[depth].unshift(chunk.slice(0, half), chunk.slice(half));
        continue;
      }
      const e = chunk[0]!;
      const p = pending.get(e.ca);
      let ended = false;
      if (p?.jobId !== undefined && jobChecks > 0) {
        // an older TokenSage refused the whole batch for a queued mint whose job failed
        jobChecks -= 1;
        ended = await checkEndedJob(api, e.ca, p, p.jobId);
      }
      if (!ended) {
        // Re-sent as it is, it would be refused every flush: left alone for one window.
        pending.delete(e.ca);
        wanted.delete(e.ca);
        rememberNotFound(e.ca, Date.now() + NOT_FOUND_COOLDOWN_MS);
        logger.warn("TokenSage refused one mint's request; leaving it out for a while", {
          status: err.status,
          depth,
          mint: e.ca,
        });
      }
      continue;
    }
    const { items, fullRemaining } = result;
    if (fullRemaining === 0) fullBlockedUntil = nextUtcMidnight(Date.now());
    const sent = new Map(chunk.map((e) => [e.ca, e]));
    for (const e of chunk) {
      const w = wanted.get(e.ca);
      if (!w) continue;
      // The basic half of a full upgrade was sent. The full request stays noted.
      if (depth === "basic" && w.alsoBasic && w.depth === "full") {
        w.alsoBasic = false;
        continue;
      }
      if (narrativeDepthCovers(depth, w.depth)) wanted.delete(e.ca);
    }
    for (const item of items) {
      const entry = typeof item?.ca === "string" ? sent.get(item.ca) : undefined;
      if (!entry) continue;
      try {
        // New unless a job at least this deep is already queued: a full read sent over a
        // queued basic one starts a full job, which costs full quota. A mint turned away
        // (quota, overload) or refused as invalid started no job, so it costs no budget: counting
        // it spent the day's full and early budgets on retries while TokenSage was overloaded.
        const queued = pending.get(item.ca);
        const turnedAway =
          item.status === "invalid" ||
          (item.status === "failed" && (item.error === "quota_exceeded" || item.error === "overloaded"));
        if (!turnedAway && (!queued || !narrativeDepthCovers(queued.depth, depth))) {
          stats.requested += 1;
          if (depth === "full") fullSentToday += 1;
          if (depth === "full" && earlyMints.has(item.ca)) earlySentToday += 1;
        }
        if (
          (item.status === "complete" || item.status === "partial") &&
          item.analysis !== null &&
          typeof item.analysis === "object"
        ) {
          // A basic answer for a mint whose full read was queued in this flush leaves that queued.
          if (!queued || narrativeDepthCovers(depth, queued.depth)) pending.delete(item.ca);
          await storeAnalysis(item.ca, item.analysis, item.status);
        } else if (item.status === "pending") {
          const prev = pending.get(item.ca);
          const jobId = typeof item.job_id === "number" ? item.job_id : undefined;
          if (!prev || !narrativeDepthCovers(prev.depth, depth)) {
            pending.set(item.ca, {
              depth,
              priority: entry.priority,
              hints: entry.hints,
              since: prev?.since ?? Date.now(),
              jobId,
            });
          } else {
            // To the back of the queue, so a backlog bigger than one flush is re-sent in turn.
            pending.delete(item.ca);
            pending.set(item.ca, prev);
            // Only at the queued depth: a basic re-send for a mint upgraded to full in this flush
            // answers with the basic job, which is not the queued full job ending.
            if (
              prev.depth === depth &&
              prev.jobId !== undefined &&
              jobId !== undefined &&
              jobId !== prev.jobId
            ) {
              // A re-send that comes back under a new job means the old one ended without an
              // analysis; TokenSage's batch doesn't say why, so read the old job once.
              const ended = prev.jobId;
              prev.jobId = jobId;
              if (jobChecks > 0) {
                jobChecks -= 1;
                await checkEndedJob(api, item.ca, prev, ended);
              }
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
          // An early deep read keeps its place on the early budget when it is asked for again.
          if (!wanted.has(item.ca))
            wanted.set(item.ca, {
              depth,
              priority: entry.priority,
              hints: entry.hints,
              ...(depth === "full" && earlyMints.has(item.ca) ? { early: true } : {}),
              notedAt: Date.now(),
            });
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
          rememberNotFound(item.ca, Date.now() + NOT_FOUND_COOLDOWN_MS);
        }
      } catch (err) {
        // One bad item (an odd document, a DB hiccup) must not lose the rest of the batch.
        stats.errors += 1;
        logger.warn("TokenSage item not stored", { mint: item.ca, error: (err as Error).message });
      }
    }
  }
}

/** Sorts in place by the coin's launch time, newest first; coins with no launch time go last. */
function newestFirst(list: { hints?: TokenSageHints }[]): void {
  const at = (e: { hints?: TokenSageHints }) => {
    const t = e.hints?.created_at ? Date.parse(e.hints.created_at) : Number.NaN;
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  list.sort((a, b) => at(b) - at(a));
}

/** Tier by tier, most urgent first; within a tier, re-sends and new requests in turn. */
function byTier<T extends { priority: TokenSagePriority }>(resend: T[], fresh: T[]): T[] {
  return PRIORITY_TIERS.flatMap((tier) =>
    interleave(
      resend.filter((e) => e.priority === tier),
      fresh.filter((e) => e.priority === tier),
    ),
  );
}

/**
 * Re-sends and new requests, a chunk of each in turn. Re-sends first would let a slow TokenSage's
 * queue fill every batch of every flush (each pending mint is re-sent until it finishes or is
 * given up), so no new mint was asked for until those aged out; new first would leave finished
 * jobs uncollected.
 */
function interleave<T>(resend: T[], fresh: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(resend.length, fresh.length); i += TOKENSAGE_PREFETCH_CHUNK) {
    out.push(
      ...resend.slice(i, i + TOKENSAGE_PREFETCH_CHUNK),
      ...fresh.slice(i, i + TOKENSAGE_PREFETCH_CHUNK),
    );
  }
  return out;
}

/**
 * A mint's previous job ended without an analysis. A definitive failure (not a token mint, not a
 * pump.fun coin) is cached so it is never asked again - otherwise every re-send would start a new
 * job, and at full depth each one costs a unit of the daily quota. A mint not on-chain yet is
 * left alone past TokenSage's 10-minute failure window. Anything else keeps the new job. True
 * when the job had failed that way - the mint is what got its batch refused.
 */
async function checkEndedJob(
  api: TokenSageClient,
  mint: string,
  p: Pending,
  endedJobId: number,
): Promise<boolean> {
  try {
    const job = await api.job(endedJobId);
    if (job.status !== "failed") return false;
    const code = String(job.error ?? "")
      .split(":")[0]!
      .trim();
    if (code === "token_not_found" || DEFINITIVE_FAILURES.includes(code)) {
      await noteFailure(mint, p.depth, job.error);
      return true;
    }
  } catch (err) {
    logger.warn("TokenSage job lookup failed", { error: String(err) });
  }
  return false;
}
