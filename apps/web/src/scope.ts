import type { Card } from "./api";
import { nowReading } from "./components/AlertCard";

/**
 * Scope: the Live feed as a three-column board of compact rows (user ask 2026-10-18): your own
 * filters' alerts, the models' calls, and every graduated token that passes the safety screen.
 * Its Stream switch (user ask 2026-10-18, in place of the old Stream tab) swaps the first two for
 * the Stream's new tokens and the ones about to graduate.
 */
export type ScopeColumn = "filters" | "models" | "new" | "soon" | "graduated";

/**
 * A card's market cap now, else at its scan: how close a coin still on its curve is to graduating,
 * since a launchpad curve completes at a set market cap (Pump.fun's at about $70-90K).
 */
const mcapOf = (card: Card): number => nowReading(card) ?? card.snapshot.marketCapUsd ?? 0;

export const SCOPE_COLUMNS: { id: ScopeColumn; label: string; short: string; hint: string }[] = [
  {
    id: "filters",
    label: "Your filters",
    short: "Filters",
    hint: "Alerts your own filters caught, newest first",
  },
  { id: "models", label: "Models", short: "Models", hint: "Calls from the models you follow, newest first" },
  {
    id: "new",
    label: "New",
    short: "New",
    hint: "New tokens the moment they pass the safety screen in the band, newest first",
  },
  {
    id: "soon",
    label: "About to graduate",
    short: "Soon",
    hint: "The same tokens as New, closest to graduating first",
  },
  {
    id: "graduated",
    label: "Graduated",
    short: "Graduated",
    hint: "Every token that graduated and passes the safety screen, and your alerts once their coin graduates",
  },
];

/** The columns on the board: the Stream's two in place of the alerts' two when Stream is on. */
export function scopeColumnsFor(stream: boolean): typeof SCOPE_COLUMNS {
  const ids: ScopeColumn[] = stream ? ["new", "soon", "graduated"] : ["filters", "models", "graduated"];
  return SCOPE_COLUMNS.filter((c) => ids.includes(c.id));
}

/** API pages of the Stream Scope reads when Stream is on, for New and About to graduate. */
export const SCOPE_STREAM_PAGES = 3;

/** API pages of the Live feed Scope reads: the newest alerts, enough to fill both its columns. */
export const SCOPE_PAGES = 5;

/** The live tick's limit on tokens per request (LIVE_TICK_MAX_TOKENS in the API). */
const MAX_TICK_TOKENS = 30;

export type ScopeColumns = Record<ScopeColumn, Card[]>;

export const emptyColumns = (): ScopeColumns => ({
  filters: [],
  models: [],
  new: [],
  soon: [],
  graduated: [],
});

/** Whether an alert's coin has graduated, by its own scans or by a Graduated column entry. */
export function cardGraduated(card: Card, gradTokens: ReadonlySet<string>): boolean {
  return (
    card.latestSnapshot?.graduated === true ||
    card.snapshot.graduated === true ||
    gradTokens.has(card.tokenId)
  );
}

/** An alert time in ms; a missing or bad one counts as latest. */
function timeOf(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : Infinity;
}

/**
 * The Live feed's cards in their columns, each keeping the feed's newest-first order, next to the
 * graduated tokens. A filter alert a model call folded into is in both: it is your alert and the
 * model's call. An alert whose coin has graduated moves to the Graduated column (user ask
 * 2026-10-18), in its coin's place there or by its alert time, keeping its filter or model marker;
 * `keepGraduated` leaves it in its own column too. New and About to graduate hold the same Stream
 * tokens still on their curve (user ask 2026-10-19), New newest first and About to graduate by
 * market cap, biggest (closest to graduating) first.
 */
export function splitScope(
  feed: readonly Card[],
  graduated: readonly Card[],
  keepGraduated: { filters: boolean; models: boolean } = { filters: false, models: false },
  stream: readonly Card[] = [],
): ScopeColumns {
  const out = emptyColumns();
  const gradTokens = new Set(graduated.map((c) => c.tokenId));
  const seen = new Set<string>();
  for (const card of stream) {
    if (seen.has(card.tokenId) || cardGraduated(card, gradTokens)) continue;
    seen.add(card.tokenId);
    out.new.push(card);
  }
  out.soon = [...out.new].sort((a, b) => mcapOf(b) - mcapOf(a));
  const moved = new Map<string, Card>();
  // A token both a filter and a model alerted on sits only in the column that alerted first (user
  // ask 2026-10-19); a tie, or no times to go by, goes to Your filters.
  const inFilters = (card: Card, grad: boolean) => card.kind === "match" && (!grad || keepGraduated.filters);
  const inModels = (card: Card, grad: boolean) => card.curated !== null && (!grad || keepGraduated.models);
  const first = new Map<string, { filters: number | null; models: number | null }>();
  for (const card of feed) {
    const grad = cardGraduated(card, gradTokens);
    const t = first.get(card.tokenId) ?? { filters: null, models: null };
    if (inFilters(card, grad)) t.filters = Math.min(t.filters ?? Infinity, timeOf(card.matchedAt));
    if (inModels(card, grad)) t.models = Math.min(t.models ?? Infinity, timeOf(card.curated?.alertedAt));
    first.set(card.tokenId, t);
  }
  const filtersFirst = (tokenId: string) => {
    const t = first.get(tokenId);
    return t?.filters != null && (t.models == null || t.filters <= t.models);
  };
  for (const card of feed) {
    const grad = cardGraduated(card, gradTokens);
    if (grad && !moved.has(card.tokenId)) moved.set(card.tokenId, card);
    if (filtersFirst(card.tokenId)) {
      if (inFilters(card, grad)) out.filters.push(card);
    } else if (inModels(card, grad)) out.models.push(card);
  }
  if (moved.size === 0) {
    out.graduated = [...graduated];
    return out;
  }
  // Each row with the time it sorts by: an entry's own, which its alert takes over in place.
  const rows = graduated.map((c) => {
    const alert = moved.get(c.tokenId);
    moved.delete(c.tokenId);
    return { card: alert ?? c, at: Date.parse(c.matchedAt) };
  });
  for (const card of moved.values())
    rows.push({
      card,
      at: Date.parse(card.curated && card.kind !== "match" ? card.curated.alertedAt : card.matchedAt),
    });
  out.graduated = rows.sort((a, b) => (b.at || 0) - (a.at || 0)).map((r) => r.card);
  return out;
}

/** The ids on each column, in order: what a paused board holds still. */
export type ScopeFrame = Record<ScopeColumn, string[]>;

export function frameOf(cols: ScopeColumns): ScopeFrame {
  const ids = (col: ScopeColumn) => cols[col].map((c) => c.id);
  return {
    filters: ids("filters"),
    models: ids("models"),
    new: ids("new"),
    soon: ids("soon"),
    graduated: ids("graduated"),
  };
}

/**
 * A paused board: every row stays where it was (fresh figures, same place), so nothing moves
 * under a pointer or thumb about to tap it. A row whose alert left the feed keeps its last card.
 * `fresh` is the board as it would be now; `pending` counts its alerts the frame hasn't drawn.
 */
export function holdFrame(
  frame: ScopeFrame,
  fresh: ScopeColumns,
  last: ReadonlyMap<string, Card>,
): { cols: ScopeColumns; pending: number } {
  const byId = new Map<string, Card>();
  for (const col of SCOPE_COLUMNS) for (const c of fresh[col.id]) byId.set(c.id, c);
  const cols = emptyColumns();
  // A column the frame drew empty (its data hadn't arrived yet, say) fills in as it comes: there
  // are no rows on screen to shift, so nothing to hold back.
  const open = new Set(SCOPE_COLUMNS.filter((c) => frame[c.id].length === 0).map((c) => c.id));
  for (const { id: col } of SCOPE_COLUMNS) {
    if (open.has(col)) {
      cols[col] = [...fresh[col]];
      continue;
    }
    for (const id of frame[col]) {
      const card = byId.get(id) ?? last.get(id);
      if (card) cols[col].push(card);
    }
  }
  // New rows: one a column hasn't drawn yet (a folded alert counts once).
  const waiting = new Set<string>();
  for (const { id: col } of SCOPE_COLUMNS) {
    if (open.has(col)) continue;
    const drawn = new Set(frame[col]);
    for (const c of fresh[col]) if (!drawn.has(c.id)) waiting.add(c.id);
  }
  return { cols, pending: waiting.size };
}

/**
 * The tokens to keep "Now" seconds old, within the live tick's limit: each column's top rows in
 * turn, newest first, so what is on screen first stays live.
 */
export function scopeTickIds(cols: ScopeColumns): string[] {
  const out = new Set<string>();
  const depth = Math.max(...SCOPE_COLUMNS.map((c) => cols[c.id].length));
  for (let i = 0; i < depth && out.size < MAX_TICK_TOKENS; i++) {
    for (const { id } of SCOPE_COLUMNS) {
      const card = cols[id][i];
      if (card && out.size < MAX_TICK_TOKENS) out.add(card.tokenId);
    }
  }
  return [...out];
}

/** An alert's age as the board's rows say it: "14s", "3m", "2h", "1d". */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
