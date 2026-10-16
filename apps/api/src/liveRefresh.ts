import { createLogger, refreshLiveMarketData, type DexScreenerClient } from "@trenchscanner/core";

const logger = createLogger("live-refresh");

/** DexScreener's batch lookup takes 30 addresses per call - see DexScreenerClient. */
const ADDRESSES_PER_CALL = 30;
const BUDGET_WINDOW_MS = 60_000;
const MAX_DURATIONS = 200;
/**
 * Readers whose per-user call windows are tracked at once. Past this, the least recently
 * charged reader's window is forgotten - at worst they get a fresh sub-budget early, and the
 * global budget still caps the total.
 */
const MAX_BUDGET_USERS = 5_000;
/** See OnDemandLiveRefresherOptions.batchWindowMs. */
const BATCH_WINDOW_MS = 250;
/**
 * Lookups (batches opened and not yet answered) at once, past which a new one is skipped like an
 * over-budget one. The call budget is a window: it let a minute's calls start in seconds, the
 * client's rate gate then sent them out at its sustained pace, and lookups sat queued for up to
 * 35 s with every tick that shared one waiting out LIVE_TICK_WAIT_MS on it (load test,
 * 2026-10-16). A few at once is what the gate passes without a queue.
 */
const MAX_LOOKUPS_IN_FLIGHT = 4;

/** The shape GET /matches already has to hand for every token on the page. */
export interface RefreshableToken {
  id: string;
  mintAddress: string;
  liveDataAt: Date | null;
}

export interface OnDemandLiveRefresherOptions {
  /**
   * How old a token's live reading may be before opening a page is worth a fresh lookup for it.
   * Set to the worker's live-price cadence: anything fresher than that is already as current as
   * the worker keeps it, so a page load refreshing it would buy nothing. The live tick
   * (GET /live/market) asks for a tighter bound per call; this is also the ceiling on that.
   */
  maxAgeMs: number;
  /** Hard cap on tokens per refresh - one page's worth, i.e. one batched DexScreener call. */
  limit: number;
  /**
   * Upstream calls this process may make per minute, across every reader. DexScreener allows
   * 300 a minute on the batch endpoint; the worker spends some of that from its own host. Past
   * the budget a refresh is skipped and readers get the worker's once-a-minute numbers, which is
   * slower, never broken.
   */
  callsPerMinute?: number;
  /**
   * Upstream calls one reader may spend per minute, on top of the global budget. Without it a
   * single subscriber paging through /matches?page=2..500 (or rotating /live/market token sets)
   * could spend the whole global budget alone and leave every other reader's live tick on the
   * worker's numbers. Only applies to calls that name a reader; anonymous ones count against the
   * global budget only.
   */
  callsPerUserPerMinute?: number;
  /** Where the refreshed tokens' matches get their peak raised - see refreshLiveMarketData. */
  peakWindowDays?: number;
  /**
   * How long a lookup waits for other readers' due tokens to share its call (default
   * BATCH_WINDOW_MS). Short next to DexScreener's own 150-450 ms answer and the live tick's wait.
   */
  batchWindowMs?: number;
}

/**
 * Refreshes market data for the tokens on screen, on request.
 *
 * Two callers. A page load (GET /matches, GET /curated) fires one off without waiting, at the
 * worker's cadence, so a page opened between worker ticks doesn't sit on old numbers. The live
 * tick (GET /live/market), which an open dashboard polls every few seconds, waits for one at a
 * much tighter bound so the numbers it returns are seconds old rather than up to a minute.
 *
 * Four things keep this from turning every poll into an upstream call:
 *
 *  - Freshness. A token whose reading is younger than the bound is skipped outright.
 *  - In-flight sharing. Concurrent requests for the same token (several users on the same page,
 *    a page load and a tick together) share one lookup, and a waiting caller waits on it.
 *  - A cooldown on *attempts*, not successes. A token DexScreener has no data for never gets
 *    liveDataAt written, so it would look stale forever and be retried on every request.
 *  - A per-minute call budget, so the number of readers can't push the API over DexScreener's
 *    rate limit.
 *
 * One instance per process (server.ts), shared by every route, so all of the above hold across
 * routes rather than per route.
 */
/** Tokens waiting to share one upstream call - see OnDemandLiveRefresher.start. */
interface Batch {
  tokens: RefreshableToken[];
  /** Resolves when the batch goes out. */
  go: () => void;
  sent: boolean;
  timer: NodeJS.Timeout | undefined;
  lookup: Promise<number>;
}

export class OnDemandLiveRefresher {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** The batch still taking tokens, if any. */
  private open: Batch | null = null;
  /** Batches opened and not yet answered - see MAX_LOOKUPS_IN_FLIGHT. */
  private lookupsInFlight = 0;
  private readonly batchWindowMs: number;
  private readonly attemptedAt = new Map<string, number>();
  private readonly calls: number[] = [];
  /**
   * Each reader's calls in the last minute, oldest first. Insertion order doubles as "least
   * recently charged" (a charge re-inserts the key), which is what the size cap evicts by.
   */
  private readonly userCalls = new Map<string, number[]>();
  /**
   * Since start: lookups made, tokens asked for and how many came back with data (the gap is
   * what DexScreener had nothing for, or a call that failed inside the client), lookups that
   * threw, and refreshes skipped for budget.
   */
  private readonly counters = {
    lookups: 0,
    tokens: 0,
    updated: 0,
    failures: 0,
    overBudget: 0,
    /** The subset of overBudget refused by a reader's own sub-budget rather than the global one. */
    userOverBudget: 0,
    /** The subset of overBudget skipped because MAX_LOOKUPS_IN_FLIGHT lookups were still out. */
    backlogged: 0,
    since: new Date(),
  };
  /** Age (ms) of the oldest reading in each live tick answer, newest last - see noteServed. */
  private readonly served: number[] = [];
  /** The latest lookups' durations (ms), newest last - for /stats/live. */
  private readonly durations: number[] = [];

  constructor(
    private readonly dexScreener: DexScreenerClient,
    private readonly options: OnDemandLiveRefresherOptions,
  ) {
    this.batchWindowMs = options.batchWindowMs ?? BATCH_WINDOW_MS;
  }

  /**
   * Fire-and-forget: never awaited by the request handler, so a slow DexScreener can't slow down
   * (or fail) the page load that triggered it.
   */
  request(tokens: readonly RefreshableToken[], userKey?: string): void {
    void this.refresh(tokens, Date.now(), undefined, userKey).catch((err) => {
      logger.warn("on-demand live refresh failed", { error: String(err) });
    });
  }

  /**
   * Refreshes whatever of `tokens` is older than `maxAgeMs` and waits - at most `timeoutMs` - for
   * that and for any lookup already in flight for these tokens. Resolves true when anything was
   * looked up or waited on, i.e. when re-reading the rows can find newer numbers. Never throws.
   * `userKey` names the reader whose sub-budget a new lookup is charged to.
   */
  async refreshAndWait(
    tokens: readonly RefreshableToken[],
    { maxAgeMs, timeoutMs, userKey }: { maxAgeMs: number; timeoutMs: number; userKey?: string },
  ): Promise<boolean> {
    const pending = new Set<Promise<unknown>>();
    for (const token of tokens) {
      const running = this.inFlight.get(token.mintAddress);
      if (running) pending.add(running);
    }
    const own = this.start(tokens, Date.now(), maxAgeMs, userKey);
    if (own) pending.add(own);
    if (pending.size === 0) return false;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.allSettled(pending), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return true;
  }

  /** Awaitable form of {@link request}. Returns how many tokens it actually looked up. */
  async refresh(
    tokens: readonly RefreshableToken[],
    now = Date.now(),
    maxAgeMs?: number,
    userKey?: string,
  ): Promise<number> {
    return (await this.start(tokens, now, maxAgeMs, userKey)) ?? 0;
  }

  /**
   * Picks what is due and queues it for a lookup, synchronously, so a caller knows at once
   * whether there is anything to wait for. Null when nothing is due or the budget is spent.
   *
   * Due tokens join the batch other readers opened in the last BATCH_WINDOW_MS when it has room,
   * and only a batch that has to be opened costs a call. Each live tick used to make its own call
   * for the handful of its tokens that were due - four or five on average with 100 dashboards
   * open (load test, 2026-10-16) - so the call budget ran out at a fraction of what DexScreener's
   * 30 addresses a call could carry, lookups queued behind the client's rate gate for 15-35 s,
   * and every tick waiting on them answered after its full LIVE_TICK_WAIT_MS with old numbers.
   */
  private start(
    tokens: readonly RefreshableToken[],
    now: number,
    maxAgeMs?: number,
    userKey?: string,
  ): Promise<number> | null {
    const due = this.selectDue(tokens, now, maxAgeMs);
    if (due.length === 0) return null;
    const open = this.open !== null && this.open.tokens.length < ADDRESSES_PER_CALL ? this.open : null;
    const room = open ? ADDRESSES_PER_CALL - open.tokens.length : 0;
    const newCalls = Math.ceil(Math.max(0, due.length - room) / ADDRESSES_PER_CALL);
    if (newCalls > 0 && this.lookupsInFlight + newCalls > MAX_LOOKUPS_IN_FLIGHT) {
      this.counters.overBudget += 1;
      this.counters.backlogged += 1;
      logger.debug("live refresh lookups backed up, skipping", { inFlight: this.lookupsInFlight });
      return null;
    }
    // A reader is charged for what it asks, as if it were alone: its sub-budget caps one reader
    // paging through history whoever else is online. The shared budget pays only for new calls.
    if (!this.takeBudget(Math.ceil(due.length / ADDRESSES_PER_CALL), newCalls, now, userKey)) return null;

    for (const token of due) this.attemptedAt.set(token.mintAddress, now);
    const batches = new Set<Promise<number>>();
    let rest = due;
    if (open) {
      const joining = rest.slice(0, room);
      rest = rest.slice(room);
      open.tokens.push(...joining);
      for (const token of joining) this.inFlight.set(token.mintAddress, open.lookup);
      batches.add(open.lookup);
      if (open.tokens.length >= ADDRESSES_PER_CALL) this.flush(open);
    }
    for (let i = 0; i < rest.length; i += ADDRESSES_PER_CALL) {
      const batch = this.openBatch(rest.slice(i, i + ADDRESSES_PER_CALL));
      batches.add(batch.lookup);
    }
    const mine = due.length;
    return Promise.all(batches).then(() => mine);
  }

  /** Opens a batch with these tokens; it goes out when full or BATCH_WINDOW_MS from now. */
  private openBatch(tokens: RefreshableToken[]): Batch {
    let go: () => void = () => {};
    const ready = new Promise<void>((resolve) => (go = resolve));
    this.lookupsInFlight += 1;
    // Joiners add to this list until the batch goes out, so the lookup reads it then.
    const members = [...tokens];
    const lookup: Promise<number> = ready
      .then(() => this.lookup(members))
      .finally(() => {
        this.lookupsInFlight -= 1;
        // Only this batch's entries: a later batch may already hold one of these mints again.
        for (const token of members) {
          if (this.inFlight.get(token.mintAddress) === lookup) this.inFlight.delete(token.mintAddress);
        }
      });
    const batch: Batch = { tokens: members, go, sent: false, timer: undefined, lookup };
    // Callers that never await their refresh (a page load) must not see an unhandled rejection;
    // the ones that do still get the failure.
    batch.lookup.catch(() => undefined);
    for (const token of tokens) this.inFlight.set(token.mintAddress, batch.lookup);
    if (batch.tokens.length >= ADDRESSES_PER_CALL) this.flush(batch);
    else {
      this.open = batch;
      batch.timer = setTimeout(() => this.flush(batch), this.batchWindowMs);
      batch.timer.unref?.();
    }
    return batch;
  }

  private flush(batch: Batch): void {
    if (batch.sent) return;
    batch.sent = true;
    clearTimeout(batch.timer);
    if (this.open === batch) this.open = null;
    batch.go();
  }

  /** One upstream call for a batch's tokens, and the bookkeeping around it. */
  private lookup(tokens: readonly RefreshableToken[]): Promise<number> {
    const startedAt = Date.now();
    this.counters.lookups += 1;
    this.counters.tokens += tokens.length;
    const lookup: Promise<number> = refreshLiveMarketData(this.dexScreener, tokens, {
      peakWindowDays: this.options.peakWindowDays,
    })
      .then(
        (result) => {
          this.counters.updated += result.updated;
          logger.debug("on-demand live refresh", { requested: result.requested, updated: result.updated });
          return result.requested;
        },
        (err: unknown) => {
          this.counters.failures += 1;
          throw err;
        },
      )
      .finally(() => {
        this.durations.push(Date.now() - startedAt);
        if (this.durations.length > MAX_DURATIONS) this.durations.shift();
      });
    return lookup;
  }

  /**
   * Which of these tokens are older than `maxAgeMs` (default: the configured bound, and never
   * looser than it), not already being fetched, and off cooldown. Exposed for tests.
   */
  selectDue(tokens: readonly RefreshableToken[], now: number, maxAgeMs?: number): RefreshableToken[] {
    const bound = Math.min(maxAgeMs ?? this.options.maxAgeMs, this.options.maxAgeMs);
    this.pruneAttempts(now);
    const due: RefreshableToken[] = [];
    const claimed = new Set<string>();

    for (const token of tokens) {
      if (due.length >= this.options.limit) break;
      // One page can legitimately hold several matches on the same token; only fetch it once.
      if (claimed.has(token.mintAddress)) continue;
      if (this.inFlight.has(token.mintAddress)) continue;
      const attempted = this.attemptedAt.get(token.mintAddress);
      if (attempted !== undefined && now - attempted < bound) continue;
      const age = token.liveDataAt ? now - token.liveDataAt.getTime() : Infinity;
      if (age < bound) continue;

      claimed.add(token.mintAddress);
      due.push(token);
    }
    return due;
  }

  /**
   * Records `calls` new upstream calls against the last minute's budget and, for a named reader,
   * `count` against that reader's own sub-budget, if both have room. Both are checked before
   * either is charged, so a call refused by one never spends the other.
   */
  private takeBudget(count: number, calls: number, now: number, userKey?: string): boolean {
    const budget = this.options.callsPerMinute;
    const userBudget = userKey === undefined ? undefined : this.options.callsPerUserPerMinute;
    if (budget !== undefined) {
      while (this.calls.length > 0 && now - this.calls[0]! >= BUDGET_WINDOW_MS) this.calls.shift();
    }
    let mine: number[] | undefined;
    if (userBudget !== undefined) {
      this.pruneUserCalls(now);
      mine = this.userCalls.get(userKey!) ?? [];
      if (mine.length + count > userBudget) {
        this.counters.overBudget += 1;
        this.counters.userOverBudget += 1;
        logger.debug("live refresh over this reader's call budget, skipping", { userBudget });
        return false;
      }
    }
    if (budget !== undefined && this.calls.length + calls > budget) {
      this.counters.overBudget += 1;
      logger.debug("live refresh over its call budget, skipping", { budget });
      return false;
    }
    if (budget !== undefined) for (let i = 0; i < calls; i += 1) this.calls.push(now);
    if (mine) for (let i = 0; i < count; i += 1) mine.push(now);
    if (mine) {
      // Re-insert so the map's order stays least-recently-charged first.
      this.userCalls.delete(userKey!);
      this.userCalls.set(userKey!, mine);
      if (this.userCalls.size > MAX_BUDGET_USERS) {
        this.userCalls.delete(this.userCalls.keys().next().value!);
      }
    }
    return true;
  }

  /** Drops calls older than the window, and readers left with none, from the per-user map. */
  private pruneUserCalls(now: number): void {
    for (const [key, times] of this.userCalls) {
      while (times.length > 0 && now - times[0]! >= BUDGET_WINDOW_MS) times.shift();
      if (times.length === 0) this.userCalls.delete(key);
    }
  }

  /**
   * Records how old the stalest reading in one live tick answer was - what a reader actually saw,
   * as opposed to how fast lookups are.
   */
  noteServed(oldestAgeMs: number): void {
    this.served.push(oldestAgeMs);
    if (this.served.length > MAX_DURATIONS) this.served.shift();
  }

  /** What this process's refresher has done since it started - served on /stats/live. */
  stats() {
    return {
      ...this.counters,
      callsLastMinute: this.calls.filter((t) => Date.now() - t < BUDGET_WINDOW_MS).length,
      callsPerMinuteBudget: this.options.callsPerMinute ?? null,
      callsPerUserPerMinuteBudget: this.options.callsPerUserPerMinute ?? null,
      budgetedUsers: this.userCalls.size,
      lookupMs: percentiles(this.durations),
      servedOldestAgeMs: percentiles(this.served),
    };
  }

  /** Keeps the cooldown map from growing with every token this process has ever seen. */
  private pruneAttempts(now: number): void {
    for (const [mint, at] of this.attemptedAt) {
      if (now - at >= this.options.maxAgeMs) this.attemptedAt.delete(mint);
    }
  }
}

/** p50/p95/max of a sample, null when empty. */
function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null;
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null, sample: sorted.length };
}
