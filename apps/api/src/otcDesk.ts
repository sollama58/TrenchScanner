import {
  feeDeskFromOtcCoin,
  feeDesksFromOtcRoster,
  lookupOtcDeskFee,
  otcRosterCoins,
  otcRosterNames,
  type OtcDeskFee,
} from "./feeDesks.js";

/**
 * OTC Desks' public launch roster (user ask 2026-10-21). The bare GET is only the small
 * featured set. The launches themselves are the paginated list (`?page=`, 12 per page,
 * newest first). Page 1 often repeats that featured set; the repeat is not the end of the
 * launches. A pump coin that sends its creator reward to a wallet is matched when that
 * coin's mint is on either list, or when the creator-fee wallet equals one of those
 * coins. A failed read shows nothing until a later try succeeds.
 *
 * A body that is not a roster is a failed page, not an empty final page. A failed page is
 * retried. Coins on pages after a real end page are not kept. A sweep that missed a page
 * is not cached as a full roster.
 *
 * The sweep reads only the newest MAX_PAGES pages of a list some 50,000 launches long (audit
 * 2026-10-22, RC-9). A coin it did not reach is looked up on its own (`?mint=`, which answers that
 * coin's row or none) by the paths that ask about one coin: the token page and a lookup's card
 * (otcDeskRosterFor). Those answers are cached, a miss included, under a per-minute budget.
 *
 * The sweep is incremental (user ask 2026-10-23: API audit bundle, B3). Reading all ~80 pages every
 * five minutes (every minute after a partial sweep) re-read the same old launches some 24,000-118,000
 * times a day. Now one full sweep fills the roster; each later refresh reads the featured set and the
 * newest pages only until a page holds nothing it did not already have, and adds what is new on
 * top. A refresh is kept OTC_ROSTER_FRESH_MS (15 min), so a new launch shows up within about that.
 * A full sweep that missed a page keeps what it read and carries on from that page at the next
 * refresh, instead of starting again from the top. Once every FULL_SWEEP_MS the whole list is read
 * again behind the incremental refreshes, so a reward basket changed on an older coin is picked up
 * then; the token page's own one-coin lookup still refreshes its coin every SINGLE_HIT_MS.
 *
 * The test runner does not call the host. `fetchOtcDeskRoster` and `otcDeskFees({ fetch })`
 * are what the tests drive: a roster those return is kept. The Vitest flag only skips the
 * default network call, so it does not throw away a response that was already fetched.
 * `sweepOtcRoster` is the incremental refresh with its state passed in, for the tests.
 */
const OTC_COINS_URL = "https://otcdesks.cash/api/coins";
/** Upstream pages are 12 coins. A shorter page is the end, unless `total` names more coins. */
const PAGE_SIZE = 12;
/**
 * Newest launches per sweep. The public mirror stops at 40 and keeps an archive;
 * this request has no archive, so it reads further while the roster budget lasts.
 */
const MAX_PAGES = 80;
const PAGE_CONCURRENCY = 8;
const PAGE_TIMEOUT_MS = 8_000;
/** One retry. A failed page is not stored as a hole in a finished roster. */
const PAGE_ATTEMPTS = 2;
/** The token page waits, but not past this. Coins read before the budget are kept. */
const ROSTER_BUDGET_MS = 12_000;
/** A finished refresh is reused this long (5 min until the user ask 2026-10-23). */
export const OTC_ROSTER_FRESH_MS = 15 * 60_000;
const FAILURE_MS = 60_000;
/** How often the whole list is read again, for reward baskets changed on coins past the newest pages. */
const FULL_SWEEP_MS = 6 * 60 * 60_000;
/** Coins kept across refreshes: about what one full sweep reads. The oldest go first. */
const KEEP_COINS = (MAX_PAGES + 2) * PAGE_SIZE;

/**
 * A coin's own lookup that found its desk row is kept 5 minutes: the token page's coin stays as
 * fresh as before the roster's longer cache.
 */
const SINGLE_HIT_MS = 5 * 60_000;
/** A coin the host says is not a desk coin is asked about again only after this. */
const SINGLE_MISS_MS = 30 * 60_000;
/** One-coin lookups sent a minute, per process; past it the coin goes without until the next. */
const SINGLE_PER_MINUTE = 30;
/** One-coin answers kept (the oldest first out). */
const SINGLE_KEEP = 5_000;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

let cached: {
  at: number;
  fees: Map<string, OtcDeskFee>;
  complete: boolean;
  /** The swept coins' own symbols, so a looked-up coin's basket is named as the sweep names it. */
  names: Map<string, string>;
} | null = null;
let inflight: Promise<Map<string, OtcDeskFee>> | null = null;

/**
 * How long a roster may be reused. A partial sweep still answers, but it is not a
 * fifteen-minute hit: the next read retries the page that failed.
 */
export function otcRosterCacheMs(roster: { complete: boolean; size: number }): number {
  return roster.complete && roster.size > 0 ? OTC_ROSTER_FRESH_MS : FAILURE_MS;
}

function pageUrl(url: string, page: number): string {
  const next = new URL(url);
  next.searchParams.set("page", String(page));
  return next.toString();
}

function mintKey(coin: unknown): string | null {
  if (!coin || typeof coin !== "object" || Array.isArray(coin)) return null;
  const mint = (coin as { mint?: unknown }).mint;
  return typeof mint === "string" && mint.trim() ? mint.trim() : null;
}

/** The key a coin is deduplicated and remembered by. */
function coinKey(coin: unknown): string {
  return mintKey(coin) ?? JSON.stringify(coin);
}

interface RosterPage {
  coins: unknown[];
  /** Full catalog size when the body names one. A short page is not the end while this is larger. */
  total: number | null;
}

function pageTotal(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const total = (body as { total?: unknown }).total;
  return typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : null;
}

/**
 * One page's coins, or null when the read failed. An empty list is a real end page.
 * A JSON body that is not a roster is a failure, the same as a network error: it is
 * not "no more coins".
 */
async function readCoins(
  fetchImpl: typeof fetch,
  url: string,
  budget: AbortSignal,
): Promise<RosterPage | null> {
  if (budget.aborted) return null;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.any([budget, AbortSignal.timeout(PAGE_TIMEOUT_MS)]),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const coins = otcRosterCoins(body);
    if (!coins) return null;
    return { coins, total: pageTotal(body) };
  } catch {
    return null;
  }
}

/** Retry a failed page. An empty roster page is the end, so it is not retried. */
async function readPage(
  fetchImpl: typeof fetch,
  url: string,
  budget: AbortSignal,
): Promise<RosterPage | null> {
  for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
    const page = await readCoins(fetchImpl, url, budget);
    if (page !== null) return page;
    if (budget.aborted) break;
  }
  return null;
}

interface RosterLoad {
  /** The rows kept, in the order read (a mint's featured row, then the row naming its basket). */
  coins: unknown[];
  /** False when a page failed or the budget cut the sweep off before the list ended. */
  complete: boolean;
  /**
   * The first page this sweep did not read (it failed, or the budget ran out before it); null when
   * every page up to the end, or up to the known coins, was read. The featured set is not counted.
   */
  resume: number | null;
}

interface LoadOptions {
  budget?: AbortSignal;
  /** First page read; 1 (the default) also reads the featured set first. */
  from?: number;
  /** Stop after the first page whose coins are all in here: the rest were read before. */
  known?: ReadonlySet<string>;
}

async function loadRoster(fetchImpl: typeof fetch, url: string, opts: LoadOptions = {}): Promise<RosterLoad> {
  const budget = opts.budget ?? AbortSignal.timeout(ROSTER_BUDGET_MS);
  const from = opts.from ?? 1;
  const known = opts.known;
  const coins: unknown[] = [];
  const seen = new Set<string>();
  /** Mints whose stored row already names reward coins. A later empty row does not replace it. */
  const rewarded = new Set<string>();
  let incomplete = false;
  let resume: number | null = null;
  const missed = (page: number): void => {
    incomplete = true;
    if (resume === null || page < resume) resume = page;
  };
  const keep = (coin: unknown, key: string): void => {
    if (feeDeskFromOtcCoin(coin)) rewarded.add(key);
    coins.push(coin);
  };
  // "stop" is a real end: an empty page, or a short page that added launches. ?page=1
  // repeating the featured mints is not an end. A failed page is skipped, not the end.
  // A short page is not the end when the body names a larger `total` than the coins kept.
  // With `known`, a page of coins all read before is where this incremental read stops.
  const take = (page: RosterPage | null, pageOne: boolean): "stop" | "more" | "skip" => {
    if (!page) return "skip";
    if (page.coins.length === 0) return "stop";
    let fresh = 0;
    for (const coin of page.coins) {
      const key = coinKey(coin);
      if (seen.has(key)) {
        // The featured row is often this mint with no reward fields. Keep the later
        // row that actually names the basket.
        if (!rewarded.has(key) && feeDeskFromOtcCoin(coin)) keep(coin, key);
        continue;
      }
      seen.add(key);
      keep(coin, key);
      fresh += 1;
    }
    if (known && page.coins.every((coin) => known.has(coinKey(coin)))) return "stop";
    if (pageOne && fresh === 0) return "more";
    if (fresh === 0) return "stop";
    if (page.coins.length < PAGE_SIZE && !(page.total != null && page.total > seen.size)) return "stop";
    return "more";
  };
  let ended = false;
  let next = from;
  if (from === 1) {
    if (take(await readPage(fetchImpl, url, budget), false) === "skip") incomplete = true;
    // A short page of new launches is the whole list. A page-1 copy of the featured set is not.
    // A failed first page still tries the next ones.
    const first = take(await readPage(fetchImpl, pageUrl(url, 1), budget), true);
    if (first === "skip") missed(1);
    ended = first === "stop";
    next = 2;
  }
  // An incremental read usually ends a page or two in: it asks one page at a time, then more at
  // once (up to PAGE_CONCURRENCY) only while the new launches go on.
  let width = known ? 1 : PAGE_CONCURRENCY;
  while (!ended && next <= MAX_PAGES && !budget.aborted) {
    const pages: number[] = [];
    for (let page = next; page < next + width && page <= MAX_PAGES; page++) pages.push(page);
    width = Math.min(width * 2, PAGE_CONCURRENCY);
    const batch = await Promise.all(pages.map((page) => readPage(fetchImpl, pageUrl(url, page), budget)));
    for (const [i, page] of batch.entries()) {
      const result = take(page, false);
      if (result === "skip") missed(pages[i]!);
      if (result === "stop") {
        ended = true;
        break;
      }
    }
    next += pages.length;
  }
  // The budget cut the list off before it ended. Coins already read are kept, but this
  // is not a finished roster. A failed page earlier set the same flag.
  if (!ended && next <= MAX_PAGES) missed(next);
  return { coins, complete: !incomplete, resume };
}

/**
 * Reward routing for every coin named on the featured list and the newest paginated pages.
 * `fetchImpl` is the test double. The default reads otcdesks.cash.
 */
export async function fetchOtcDeskRoster(
  fetchImpl: typeof fetch = fetch,
  url = OTC_COINS_URL,
): Promise<Map<string, OtcDeskFee>> {
  return feesOf((await loadRoster(fetchImpl, url)).coins);
}

function feesOf(coins: unknown[]): Map<string, OtcDeskFee> {
  return coins.length === 0 ? new Map<string, OtcDeskFee>() : feeDesksFromOtcRoster({ coins });
}

/** A roster's rows by coin key, newest first. A key holds its featured row and its basket row. */
type RosterRows = Map<string, unknown[]>;

function rowsOf(coins: readonly unknown[]): RosterRows {
  const rows: RosterRows = new Map();
  for (const coin of coins) {
    const key = coinKey(coin);
    const list = rows.get(key);
    if (list) list.push(coin);
    else rows.set(key, [coin]);
  }
  return rows;
}

/**
 * `newer` (just read) over `older` (kept): a key read again takes its new rows, except that rows
 * naming no basket do not drop a basket kept from before (the same rule as within one sweep).
 * `newerFirst` puts the new keys in front (new launches); otherwise they go after the kept ones.
 */
function mergeRows(newer: RosterRows, older: RosterRows, newerFirst: boolean): RosterRows {
  const pick = (key: string): unknown[] => {
    const fresh = newer.get(key);
    const kept = older.get(key);
    if (!fresh) return kept!;
    if (!kept || fresh.some((coin) => feeDeskFromOtcCoin(coin))) return fresh;
    return [...fresh, ...kept.filter((coin) => feeDeskFromOtcCoin(coin))];
  };
  const out: RosterRows = new Map();
  for (const key of newerFirst ? [...newer.keys(), ...older.keys()] : [...older.keys(), ...newer.keys()]) {
    if (!out.has(key)) out.set(key, pick(key));
  }
  for (const oldest of [...out.keys()].slice(KEEP_COINS)) out.delete(oldest);
  return out;
}

/** What the incremental refresh keeps between calls. */
export interface OtcRosterSweep {
  rows: RosterRows;
  /** The page an unfinished full sweep carries on from; null when it reached the end. */
  resume: number | null;
  /** When the newest full sweep began. */
  fullAt: number;
}

/**
 * One incremental refresh. With no state, a full sweep. Otherwise the featured set and the newest
 * pages down to the first page of coins already kept; when that read was whole, the coins it found
 * go in front of the kept ones and an unfinished full sweep carries on from its page with the
 * budget left. A head read that missed a page is shown but not kept: the next refresh reads the
 * head again against the same coins, so a launch on the missed page is not skipped over for good.
 * `complete` says whether this roster is a fifteen-minute one.
 */
export async function sweepOtcRoster(
  state: OtcRosterSweep | null,
  fetchImpl: typeof fetch,
  now: number,
  url = OTC_COINS_URL,
): Promise<{ state: OtcRosterSweep; coins: unknown[]; complete: boolean }> {
  const budget = AbortSignal.timeout(ROSTER_BUDGET_MS);
  if (!state) {
    const full = await loadRoster(fetchImpl, url, { budget });
    const rows = mergeRows(rowsOf(full.coins), new Map(), true);
    return {
      state: { rows, resume: full.resume, fullAt: now },
      coins: [...rows.values()].flat(),
      complete: full.complete,
    };
  }
  let { rows, resume, fullAt } = state;
  if (resume === null && now - fullAt >= FULL_SWEEP_MS) {
    resume = 1;
    fullAt = now;
  }
  const head = await loadRoster(fetchImpl, url, { budget, known: new Set(rows.keys()) });
  if (!head.complete) {
    const shown = mergeRows(rowsOf(head.coins), rows, true);
    return { state: { rows, resume, fullAt }, coins: [...shown.values()].flat(), complete: false };
  }
  rows = mergeRows(rowsOf(head.coins), rows, true);
  if (resume !== null && !budget.aborted) {
    // Pages only move down as launches are added, so carrying on from the page number the last
    // sweep stopped at re-reads a few coins at worst; it never skips one.
    const rest = await loadRoster(fetchImpl, url, { budget, from: resume });
    rows = mergeRows(rowsOf(rest.coins), rows, false);
    resume = rest.resume;
  }
  return { state: { rows, resume, fullAt }, coins: [...rows.values()].flat(), complete: resume === null };
}

let sweep: OtcRosterSweep | null = null;

function freshEnough(): boolean {
  if (!cached) return false;
  return Date.now() - cached.at < otcRosterCacheMs({ complete: cached.complete, size: cached.fees.size });
}

async function refresh(): Promise<Map<string, OtcDeskFee>> {
  try {
    const result = await sweepOtcRoster(sweep, fetch, Date.now());
    sweep = result.state;
    const fees = feesOf(result.coins);
    cached = { at: Date.now(), fees, complete: result.complete, names: otcRosterNames(result.coins) };
    return fees;
  } catch {
    cached = {
      at: Date.now(),
      fees: cached?.fees ?? new Map(),
      complete: false,
      names: cached?.names ?? new Map(),
    };
    return cached.fees;
  }
}

function pick(fees: Map<string, OtcDeskFee>, mints: readonly string[]): Map<string, OtcDeskFee> {
  const out = new Map<string, OtcDeskFee>();
  for (const mint of mints) {
    const fee = fees.get(mint);
    if (fee) out.set(mint, fee);
  }
  return out;
}

export interface OtcDeskFeesOptions {
  /** Hold for the roster (the token page). The feed uses the cache and refreshes behind the request. */
  wait?: boolean;
  /**
   * Reads the roster from this fetch instead of the host. Set by tests. Production omits it.
   * A response it returns is the roster: the Vitest skip below does not apply.
   */
  fetch?: typeof fetch;
}

/**
 * The roster kept for fee matching, keyed by coin mint and by a wallet that belongs
 * to exactly one rewarded coin. `wait` holds for it (the token page). The feed does not:
 * it uses whatever is already cached and refreshes behind the request. A supplied fetch
 * is the roster and skips the cache.
 */
export async function otcDeskRoster(opts?: OtcDeskFeesOptions): Promise<Map<string, OtcDeskFee>> {
  // A supplied fetch is the roster. Do not drop it because the test runner is on.
  if (opts?.fetch) return fetchOtcDeskRoster(opts.fetch);
  // Card tests call this with no fetch. They must not reach otcdesks.cash.
  if (process.env.VITEST === "true") return new Map();
  if (!freshEnough()) {
    if (opts?.wait) {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      await inflight;
    } else if (!inflight) {
      inflight = refresh().finally(() => {
        inflight = null;
      });
    }
  }
  return cached?.fees ?? new Map();
}

export async function otcDeskFees(
  mints: readonly string[],
  opts?: OtcDeskFeesOptions,
): Promise<Map<string, OtcDeskFee>> {
  if (mints.length === 0) return new Map();
  return pick(await otcDeskRoster(opts), mints);
}

/** One-coin answers by mint: the desk row, null for none, or "failed" (kept FAILURE_MS). */
const singles = new Map<string, { at: number; fee: OtcDeskFee | null | "failed" }>();
const singleReads = new Map<string, Promise<OtcDeskFee | null>>();
let singleWindow = { start: 0, count: 0 };

function singleFresh(entry: { at: number; fee: OtcDeskFee | null | "failed" }, now: number): boolean {
  const keep = entry.fee === "failed" ? FAILURE_MS : entry.fee ? SINGLE_HIT_MS : SINGLE_MISS_MS;
  return now - entry.at < keep;
}

async function readSingle(
  fetchImpl: typeof fetch,
  mint: string,
  names: ReadonlyMap<string, string> | undefined,
): Promise<OtcDeskFee | null | "failed"> {
  const url = new URL(OTC_COINS_URL);
  url.searchParams.set("mint", mint);
  const page = await readPage(fetchImpl, url.toString(), AbortSignal.timeout(PAGE_TIMEOUT_MS));
  if (!page) return "failed";
  // Only the coin's own row: a host that ignored the filter answers the newest page instead.
  for (const coin of page.coins) if (mintKey(coin) === mint) return feeDeskFromOtcCoin(coin, names);
  return null;
}

/**
 * `mint`'s desk row from the host's one-coin answer (`?mint=`), for a coin the sweep did not
 * reach, or null. Cached as SINGLE_HIT_MS / SINGLE_MISS_MS / FAILURE_MS; past SINGLE_PER_MINUTE
 * lookups a minute it answers null without asking (and keeps nothing, so the next minute asks).
 * A supplied fetch is the host (tests); the test runner otherwise never calls it.
 */
export async function otcDeskFeeForMint(
  mint: string,
  opts?: { fetch?: typeof fetch; now?: number },
): Promise<OtcDeskFee | null> {
  if (!BASE58.test(mint)) return null;
  if (!opts?.fetch && process.env.VITEST === "true") return null;
  const now = opts?.now ?? Date.now();
  const kept = singles.get(mint);
  if (kept && singleFresh(kept, now)) return kept.fee === "failed" ? null : kept.fee;
  const pending = singleReads.get(mint);
  if (pending) return pending;
  if (now - singleWindow.start >= 60_000) singleWindow = { start: now, count: 0 };
  if (singleWindow.count >= SINGLE_PER_MINUTE) return null;
  singleWindow.count += 1;
  const read = readSingle(opts?.fetch ?? fetch, mint, cached?.names)
    .catch(() => "failed" as const)
    .then((fee) => {
      singles.delete(mint);
      singles.set(mint, { at: now, fee });
      while (singles.size > SINGLE_KEEP) {
        const oldest = singles.keys().next().value;
        if (oldest === undefined) break;
        singles.delete(oldest);
      }
      return fee === "failed" ? null : fee;
    })
    .finally(() => singleReads.delete(mint));
  singleReads.set(mint, read);
  return read;
}

/**
 * `mint`'s one-coin answer when one is already kept: the desk row, or null for a coin the host
 * does not list. Undefined when nothing fresh is kept. Never asks the host: a feed reads this,
 * and starts otcDeskFeeForMint behind the request for the next poll.
 */
export function keptOtcDeskFeeForMint(mint: string, now = Date.now()): OtcDeskFee | null | undefined {
  const kept = singles.get(mint);
  if (!kept || !singleFresh(kept, now)) return undefined;
  return kept.fee === "failed" ? undefined : kept.fee;
}

/**
 * The roster as otcDeskRoster answers it, with `mint`'s own row added when the sweep did not
 * reach it and the host's one-coin answer has it (otcDeskFeeForMint). Only with `wait`: the
 * paths that hold for one coin (the token page, a lookup's card). A feed never asks per coin.
 */
export async function otcDeskRosterFor(
  mint: string,
  opts?: OtcDeskFeesOptions,
): Promise<ReadonlyMap<string, OtcDeskFee>> {
  const roster = await otcDeskRoster(opts);
  if (!opts?.wait || lookupOtcDeskFee(roster, mint)) return roster;
  const own = await otcDeskFeeForMint(mint, { fetch: opts.fetch });
  return own ? new Map(roster).set(mint, own) : roster;
}

/** Test seam: forget the one-coin answers and their budget. */
export function clearOtcDeskSingles(): void {
  singles.clear();
  singleReads.clear();
  singleWindow = { start: 0, count: 0 };
}
