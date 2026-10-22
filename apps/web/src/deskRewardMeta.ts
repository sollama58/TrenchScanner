import { api, type Subscription } from "./api";
import { peek } from "./cache";
import type { SearchMarketPatch } from "./cardSearch";

/**
 * Names and icons for OTC Desks reward coins the server could not fill from Token (xStocks such as
 * NVDAx, which the scanner doesn't track), from GET /tokens/search/markets.
 *
 * Every card that shows such a coin wants the same few mints, and that route is limited to 30
 * requests a minute (shared with the search window's refresh) and asks DexScreener for anything
 * it hasn't quoted lately. So the answers are kept here for the whole page, a mint with no data
 * included, a mint already asked for is not asked again while that request runs, and the mints
 * wanted within one short wait go out in one request.
 */

/** How long an answer, or a mint the route had nothing for, is reused. */
export const META_TTL_MS = 10 * 60_000;
/** A failed request (429, offline) is not retried by every card at once: this long before the next. */
const FAILED_TTL_MS = 60_000;
/** Mints wanted within this long of each other share one request. */
const BATCH_WAIT_MS = 50;
/** The route's cap on mints per request (searchMarket.ts SEARCH_MARKET_FETCH_MAX). */
const BATCH_MAX = 30;
/** The reward roster is small; this only stops the map growing without end. */
const MAX_KEPT = 500;

const kept = new Map<string, { patch: SearchMarketPatch | null; until: number }>();
const pending = new Map<string, Promise<SearchMarketPatch | null>>();
let queue: { mint: string; resolve: (patch: SearchMarketPatch | null) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** The kept answer for `mint`: a patch, null for a known miss, undefined when there is none. */
export function keptDeskRewardMeta(mint: string): SearchMarketPatch | null | undefined {
  const hit = kept.get(mint);
  if (!hit) return undefined;
  if (hit.until > Date.now()) return hit.patch;
  kept.delete(mint);
  return undefined;
}

function keep(mint: string, patch: SearchMarketPatch | null, ttlMs: number): void {
  kept.delete(mint);
  kept.set(mint, { patch, until: Date.now() + ttlMs });
  // Map order is insertion order, so the first key is the oldest answer.
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
}

function flush(): void {
  timer = null;
  const batch = queue;
  queue = [];
  for (let i = 0; i < batch.length; i += BATCH_MAX) {
    const part = batch.slice(i, i + BATCH_MAX);
    const mints = part.map((q) => q.mint).join(",");
    api<{ hits: SearchMarketPatch[] }>(`/tokens/search/markets?mints=${encodeURIComponent(mints)}`)
      .then((res) => {
        const byMint = new Map(res.hits.map((hit) => [hit.mint, hit]));
        for (const q of part) {
          const patch = byMint.get(q.mint) ?? null;
          keep(q.mint, patch, META_TTL_MS);
          q.resolve(patch);
        }
      })
      .catch(() => {
        for (const q of part) {
          keep(q.mint, null, FAILED_TTL_MS);
          q.resolve(null);
        }
      })
      .finally(() => {
        for (const q of part) pending.delete(q.mint);
      });
  }
}

/** The route is behind the paywall: a signed-out page, a guest or a lapsed account would get 401/402. */
function canAsk(): boolean {
  return peek<Subscription>("/subscription")?.data.hasAccess === true;
}

/**
 * The patches for `mints`, from what is kept where it can be and one shared request for the rest.
 * Never rejects; a mint with nothing to lay over is left out of the map.
 */
export async function loadDeskRewardMeta(mints: readonly string[]): Promise<Map<string, SearchMarketPatch>> {
  const out = new Map<string, SearchMarketPatch>();
  const waits: Promise<void>[] = [];
  const ask = canAsk();
  for (const mint of new Set(mints)) {
    const known = keptDeskRewardMeta(mint);
    if (known !== undefined) {
      if (known) out.set(mint, known);
      continue;
    }
    if (!ask) continue;
    let wait = pending.get(mint);
    if (!wait) {
      wait = new Promise<SearchMarketPatch | null>((resolve) => queue.push({ mint, resolve }));
      pending.set(mint, wait);
      timer ??= setTimeout(flush, BATCH_WAIT_MS);
    }
    waits.push(
      wait.then((patch) => {
        if (patch) out.set(mint, patch);
      }),
    );
  }
  await Promise.all(waits);
  return out;
}

/** Forgets every kept answer. For tests. */
export function resetDeskRewardMeta(): void {
  kept.clear();
  pending.clear();
  queue = [];
  if (timer) clearTimeout(timer);
  timer = null;
}
