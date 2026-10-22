import { feeDeskFromOtcCoin, feeDesksFromOtcRoster, otcRosterCoins, type OtcDeskFee } from "./feeDesks.js";

/**
 * OTC Desks' public launch roster (user ask 2026-10-21). The bare GET is only the small
 * featured set. The launches themselves are the paginated list (`?page=`, 12 per page,
 * newest first). Page 1 often repeats that featured set; the repeat is not the end of the
 * launches. A pump coin that sends its creator reward to a wallet is matched when that
 * coin's mint is on either list. A failed read shows nothing until a later try succeeds.
 *
 * A body that is not a roster is a failed page, not an empty final page. A failed page is
 * retried. Coins on pages after a real end page are not kept. A sweep that missed a page
 * is not cached as a full roster.
 *
 * The test runner does not call the host. `fetchOtcDeskRoster` and `otcDeskFees({ fetch })`
 * are what the tests drive: a roster those return is kept. The Vitest flag only skips the
 * default network call, so it does not throw away a response that was already fetched.
 */
const OTC_COINS_URL = "https://otcdesks.cash/api/coins";
/** Upstream pages are 12 coins. A shorter page is the end of the list. */
const PAGE_SIZE = 12;
/** Newest launches, the same page cap the public mirror sweeps. */
const MAX_PAGES = 40;
const PAGE_CONCURRENCY = 8;
const PAGE_TIMEOUT_MS = 8_000;
/** One retry. A failed page is not stored as a hole in a finished roster. */
const PAGE_ATTEMPTS = 2;
/** The token page waits, but not past this. Coins read before the budget are kept. */
const ROSTER_BUDGET_MS = 12_000;
const FRESH_MS = 5 * 60_000;
const FAILURE_MS = 60_000;

let cached: { at: number; fees: Map<string, OtcDeskFee>; complete: boolean } | null = null;
let inflight: Promise<Map<string, OtcDeskFee>> | null = null;

/**
 * How long a roster may be reused. A partial sweep still answers, but it is not a
 * five-minute hit: the next read retries the page that failed.
 */
export function otcRosterCacheMs(roster: { complete: boolean; size: number }): number {
  return roster.complete && roster.size > 0 ? FRESH_MS : FAILURE_MS;
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

/**
 * One page's coins, or null when the read failed. An empty list is a real end page.
 * A JSON body that is not a roster is a failure, the same as a network error: it is
 * not "no more coins".
 */
async function readCoins(
  fetchImpl: typeof fetch,
  url: string,
  budget: AbortSignal,
): Promise<unknown[] | null> {
  if (budget.aborted) return null;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.any([budget, AbortSignal.timeout(PAGE_TIMEOUT_MS)]),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const coins = otcRosterCoins(await res.json());
    return coins ?? null;
  } catch {
    return null;
  }
}

/** Retry a failed page. An empty roster page is the end, so it is not retried. */
async function readPage(
  fetchImpl: typeof fetch,
  url: string,
  budget: AbortSignal,
): Promise<unknown[] | null> {
  for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
    const page = await readCoins(fetchImpl, url, budget);
    if (page !== null) return page;
    if (budget.aborted) break;
  }
  return null;
}

interface RosterLoad {
  fees: Map<string, OtcDeskFee>;
  /** False when a page failed or the budget cut the sweep off before the list ended. */
  complete: boolean;
}

async function loadRoster(fetchImpl: typeof fetch, url: string): Promise<RosterLoad> {
  const budget = AbortSignal.timeout(ROSTER_BUDGET_MS);
  const coins: unknown[] = [];
  const seen = new Set<string>();
  /** Mints whose stored row already names reward coins. A later empty row does not replace it. */
  const rewarded = new Set<string>();
  let incomplete = false;
  const keep = (coin: unknown, key: string): void => {
    if (feeDeskFromOtcCoin(coin)) rewarded.add(key);
    coins.push(coin);
  };
  // "stop" is a real end: an empty page, or a short page that added launches. ?page=1
  // repeating the featured mints is not an end. A failed page is skipped, not the end.
  const take = (page: unknown[] | null, pageOne: boolean): "stop" | "more" | "skip" => {
    if (!page) return "skip";
    if (page.length === 0) return "stop";
    let fresh = 0;
    for (const coin of page) {
      const key = mintKey(coin) ?? JSON.stringify(coin);
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
    if (pageOne && fresh === 0) return "more";
    if (fresh === 0 || page.length < PAGE_SIZE) return "stop";
    return "more";
  };
  if (take(await readPage(fetchImpl, url, budget), false) === "skip") incomplete = true;
  // A short page of new launches is the whole list. A page-1 copy of the featured set is not.
  // A failed first page still tries the next ones.
  const first = take(await readPage(fetchImpl, pageUrl(url, 1), budget), true);
  if (first === "skip") incomplete = true;
  let ended = first === "stop";
  if (!ended) {
    for (let start = 2; start <= MAX_PAGES && !budget.aborted; start += PAGE_CONCURRENCY) {
      const pages: number[] = [];
      for (let page = start; page < start + PAGE_CONCURRENCY && page <= MAX_PAGES; page++) pages.push(page);
      const batch = await Promise.all(pages.map((page) => readPage(fetchImpl, pageUrl(url, page), budget)));
      for (const page of batch) {
        if (ended) break;
        const result = take(page, false);
        if (result === "skip") incomplete = true;
        if (result === "stop") ended = true;
      }
      if (ended) break;
    }
  }
  // The budget cut the list off before it ended. Coins already read are kept, but this
  // is not a finished roster. A failed page earlier set the same flag.
  if (budget.aborted && !ended) incomplete = true;
  const fees = coins.length === 0 ? new Map<string, OtcDeskFee>() : feeDesksFromOtcRoster({ coins });
  return { fees, complete: !incomplete };
}

/**
 * Reward routing for every coin named on the featured list and the newest paginated pages.
 * `fetchImpl` is the test double. The default reads otcdesks.cash.
 */
export async function fetchOtcDeskRoster(
  fetchImpl: typeof fetch = fetch,
  url = OTC_COINS_URL,
): Promise<Map<string, OtcDeskFee>> {
  return (await loadRoster(fetchImpl, url)).fees;
}

function freshEnough(): boolean {
  if (!cached) return false;
  return Date.now() - cached.at < otcRosterCacheMs({ complete: cached.complete, size: cached.fees.size });
}

async function refresh(): Promise<Map<string, OtcDeskFee>> {
  try {
    const loaded = await loadRoster(fetch, OTC_COINS_URL);
    cached = { at: Date.now(), fees: loaded.fees, complete: loaded.complete };
    return loaded.fees;
  } catch {
    cached = { at: Date.now(), fees: cached?.fees ?? new Map(), complete: false };
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
 * Reward coins for these mints. `wait` holds for the roster (the token page).
 * The feed does not: it uses whatever is already cached and refreshes behind the request,
 * so a cold roster does not stall every card.
 */
export async function otcDeskFees(
  mints: readonly string[],
  opts?: OtcDeskFeesOptions,
): Promise<Map<string, OtcDeskFee>> {
  if (mints.length === 0) return new Map();
  // A supplied fetch is the roster. Do not drop it because the test runner is on.
  if (opts?.fetch) return pick(await fetchOtcDeskRoster(opts.fetch), mints);
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
  const fees = cached?.fees;
  if (!fees || fees.size === 0) return new Map();
  return pick(fees, mints);
}
