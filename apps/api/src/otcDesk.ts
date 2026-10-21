import { feeDesksFromOtcRoster, otcRosterCoins, type OtcDeskFee } from "./feeDesks.js";

/**
 * OTC Desks' public launch roster (user ask 2026-10-21). The bare GET is only the small
 * featured set. The launches themselves are the paginated list (`?page=`, 12 per page,
 * newest first). A pump coin that sends its creator reward to a wallet is matched when
 * that coin's mint is on either list. A failed or empty read shows nothing.
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
/** The token page waits, but not past this. Coins read before the budget are kept. */
const ROSTER_BUDGET_MS = 12_000;
const FRESH_MS = 5 * 60_000;
const FAILURE_MS = 60_000;

let cached: { at: number; fees: Map<string, OtcDeskFee> } | null = null;
let inflight: Promise<Map<string, OtcDeskFee>> | null = null;

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
    return otcRosterCoins(await res.json()) ?? [];
  } catch {
    return null;
  }
}

/**
 * Reward routing for every coin named on the featured list and the newest paginated pages.
 * `fetchImpl` is the test double. The default reads otcdesks.cash.
 */
export async function fetchOtcDeskRoster(
  fetchImpl: typeof fetch = fetch,
  url = OTC_COINS_URL,
): Promise<Map<string, OtcDeskFee>> {
  const budget = AbortSignal.timeout(ROSTER_BUDGET_MS);
  const coins: unknown[] = [];
  const seen = new Set<string>();
  // "stop" ends the sweep: an empty page, a short page, or a page of mints we already
  // have (the host repeated the featured list). A failed page is skipped, not the end.
  const take = (page: unknown[] | null): "stop" | "more" | "skip" => {
    if (!page) return "skip";
    if (page.length === 0) return "stop";
    let fresh = 0;
    for (const coin of page) {
      const key = mintKey(coin) ?? JSON.stringify(coin);
      if (seen.has(key)) continue;
      seen.add(key);
      coins.push(coin);
      fresh += 1;
    }
    if (fresh === 0 || page.length < PAGE_SIZE) return "stop";
    return "more";
  };
  take(await readCoins(fetchImpl, url, budget));
  // A short first page is the whole list. The featured set alone is not. A failed
  // first page still tries the next ones.
  const first = take(await readCoins(fetchImpl, pageUrl(url, 1), budget));
  if (first !== "stop") {
    for (let start = 2; start <= MAX_PAGES && !budget.aborted; start += PAGE_CONCURRENCY) {
      const pages: number[] = [];
      for (let page = start; page < start + PAGE_CONCURRENCY && page <= MAX_PAGES; page++) pages.push(page);
      const batch = await Promise.all(pages.map((page) => readCoins(fetchImpl, pageUrl(url, page), budget)));
      let done = false;
      for (const page of batch) {
        if (take(page) === "stop") done = true;
      }
      if (done || budget.aborted) break;
    }
  }
  if (coins.length === 0) return new Map();
  return feeDesksFromOtcRoster({ coins });
}

function freshEnough(): boolean {
  if (!cached) return false;
  const age = Date.now() - cached.at;
  return cached.fees.size > 0 ? age < FRESH_MS : age < FAILURE_MS;
}

async function refresh(): Promise<Map<string, OtcDeskFee>> {
  try {
    const fees = await fetchOtcDeskRoster();
    cached = { at: Date.now(), fees };
    return fees;
  } catch {
    cached = { at: Date.now(), fees: cached?.fees ?? new Map() };
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
