import { api, type Card } from "./api";
import { openTokenModal } from "./tokenModal";
import type { WatchlistItem } from "./watchlist";

/** A reading older than this shows dimmed, with its age in the tooltip. */
export const STALE_MS = 30 * 60_000;
/** The scan's 1h change shows only while the snapshot it came from is this fresh. */
export const HOUR_CHANGE_FRESH_MS = 20 * 60_000;
/** The 24h change is a slower figure: an hour-old snapshot still says it well. */
export const DAY_CHANGE_FRESH_MS = 2 * 60 * 60_000;

/** $TICKER, else the name, else the shortened mint. */
export function watchLabel(item: Pick<WatchlistItem, "symbol" | "name" | "mint">): string {
  const sym = item.symbol?.trim().replace(/^\$+/, "");
  if (sym) return `$${sym}`;
  return item.name?.trim() || `${item.mint.slice(0, 4)}…${item.mint.slice(-4)}`;
}

/** up / down for a move worth colouring, flat under half a percent or unknown. */
export function changeTone(v: number | null | undefined): "up" | "down" | "flat" {
  if (v == null || Math.abs(v) < 0.5) return "flat";
  return v > 0 ? "up" : "down";
}

const fresh = (at: string | null, within: number, now: number) => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) && now - t <= within;
};

/** The scan's 1h change while it is fresh, else null. */
export function hourChange(item: WatchlistItem, now: number): number | null {
  return item.priceChange1hPct != null && fresh(item.changeAt, HOUR_CHANGE_FRESH_MS, now)
    ? item.priceChange1hPct
    : null;
}

/** The scan's 24h change while it is fresh enough, else null. */
export function dayChange(item: WatchlistItem, now: number): number | null {
  return item.priceChange24hPct != null && fresh(item.changeAt, DAY_CHANGE_FRESH_MS, now)
    ? item.priceChange24hPct
    : null;
}

/** Whether the market cap reading is old enough to dim. */
export function isStale(item: WatchlistItem, now: number): boolean {
  const t = item.at ? Date.parse(item.at) : NaN;
  return Number.isFinite(t) && now - t > STALE_MS;
}

/** Opens a watched token's view: its card from GET /tokens/:mint/card, as the search window does. */
export async function openWatched(item: Pick<WatchlistItem, "mint">): Promise<void> {
  const card = await api<Card>(`/tokens/${encodeURIComponent(item.mint)}/card`);
  openTokenModal(card, Date.now());
}
