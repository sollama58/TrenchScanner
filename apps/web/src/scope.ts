import type { Card } from "./api";

/**
 * Scope: the Live feed as a three-column board of compact rows (user ask 2026-10-18): your own
 * filters' alerts, the models' calls, and every graduated token that passes the safety screen.
 */
export type ScopeColumn = "filters" | "models" | "graduated";

export const SCOPE_COLUMNS: { id: ScopeColumn; label: string; short: string; hint: string }[] = [
  {
    id: "filters",
    label: "Your filters",
    short: "Filters",
    hint: "Alerts your own filters caught, newest first",
  },
  { id: "models", label: "Models", short: "Models", hint: "Calls from the models you follow, newest first" },
  {
    id: "graduated",
    label: "Graduated",
    short: "Graduated",
    hint: "Every token that graduated and passes the safety screen, whatever the filters or models think",
  },
];

/** API pages of the Live feed Scope reads: the newest alerts, enough to fill both its columns. */
export const SCOPE_PAGES = 5;

/** The live tick's limit on tokens per request (LIVE_TICK_MAX_TOKENS in the API). */
const MAX_TICK_TOKENS = 30;

export type ScopeColumns = Record<ScopeColumn, Card[]>;

/**
 * The Live feed's cards in their columns, each keeping the feed's newest-first order, next to the
 * graduated tokens. A filter alert a model call folded into is in both: it is your alert and the
 * model's call.
 */
export function splitScope(feed: readonly Card[], graduated: readonly Card[]): ScopeColumns {
  const out: ScopeColumns = { filters: [], models: [], graduated: [...graduated] };
  for (const card of feed) {
    if (card.kind === "match") out.filters.push(card);
    if (card.curated) out.models.push(card);
  }
  return out;
}

/** The ids on each column, in order: what a paused board holds still. */
export type ScopeFrame = Record<ScopeColumn, string[]>;

export function frameOf(cols: ScopeColumns): ScopeFrame {
  return {
    filters: cols.filters.map((c) => c.id),
    models: cols.models.map((c) => c.id),
    graduated: cols.graduated.map((c) => c.id),
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
  const cols: ScopeColumns = { filters: [], models: [], graduated: [] };
  for (const { id: col } of SCOPE_COLUMNS) {
    for (const id of frame[col]) {
      const card = byId.get(id) ?? last.get(id);
      if (card) cols[col].push(card);
    }
  }
  // New rows: one a column hasn't drawn yet (a folded alert counts once).
  const waiting = new Set<string>();
  for (const { id: col } of SCOPE_COLUMNS) {
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
