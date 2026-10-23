import type { Card } from "./api";
import { nowReading } from "./components/AlertCard";

/**
 * Scope: the Live feed as a board of compact rows (user ask 2026-10-18). Its columns are the
 * user's own (user ask 2026-10-23): up to six, each one of the kinds below - the Stream's New and
 * About to graduate, Graduated, your filters' alerts (all, or up to three filters), and model
 * calls (the models you follow, or up to three models of your choosing).
 */
export type ScopeColumnKind = "filters" | "filter" | "models" | "model" | "new" | "soon" | "graduated";

/** A column's id on the board: unique per board, kept as the column is edited or moved. */
export type ScopeColumn = string;

export interface ScopeColumnSpec {
  id: ScopeColumn;
  kind: ScopeColumnKind;
  /** Specific filters' ids ("filter") or models' ids ("model"), at most MAX_SCOPE_PICKS. */
  picks: string[];
}

export const MAX_SCOPE_COLUMNS = 6;
export const MAX_SCOPE_PICKS = 3;

export interface ScopeKindDef {
  kind: ScopeColumnKind;
  label: string;
  short: string;
  hint: string;
  /** What a column of this kind picks: specific filters or models. */
  picks?: "filter" | "model";
}

export const SCOPE_KINDS: ScopeKindDef[] = [
  {
    kind: "new",
    label: "New",
    short: "New",
    hint: "New tokens the moment they pass the safety screen in the band, newest first",
  },
  {
    kind: "soon",
    label: "About to graduate",
    short: "Soon",
    hint: "The same tokens as New, closest to graduating first",
  },
  {
    kind: "graduated",
    label: "Graduated",
    short: "Graduated",
    hint: "Every token that graduated and passes the safety screen, and your alerts once their coin graduates",
  },
  {
    kind: "filters",
    label: "Your filters",
    short: "Filters",
    hint: "Alerts any of your filters caught, newest first",
  },
  {
    kind: "filter",
    label: "Specific filters",
    short: "Filter",
    hint: "Alerts from up to three of your filters, newest first",
    picks: "filter",
  },
  {
    kind: "models",
    label: "Your models",
    short: "Models",
    hint: "Calls from the models you follow, newest first",
  },
  {
    kind: "model",
    label: "Specific models",
    short: "Model",
    hint: "Calls from up to three models of your choosing, followed or not, newest first",
    picks: "model",
  },
];

export const kindDef = (kind: ScopeColumnKind): ScopeKindDef => SCOPE_KINDS.find((k) => k.kind === kind)!;

/** Columns of your filters' alerts, and of model calls: a token both caught shows on one side only. */
export const isFilterSide = (k: ScopeColumnKind): boolean => k === "filters" || k === "filter";
export const isModelSide = (k: ScopeColumnKind): boolean => k === "models" || k === "model";
export const isAlertKind = (k: ScopeColumnKind): boolean => isFilterSide(k) || isModelSide(k);

/** The board new accounts start with: your filters, your models and Graduated. */
export const DEFAULT_SCOPE_BOARD: ScopeColumnSpec[] = [
  { id: "filters", kind: "filters", picks: [] },
  { id: "models", kind: "models", picks: [] },
  { id: "graduated", kind: "graduated", picks: [] },
];

/**
 * A column's name on the board: its kind, or for specific filters and models the picked ones'
 * names ("Fast + Deep", "Atlas +2"), from `names` (id to name) where known.
 */
export function columnLabel(col: ScopeColumnSpec, names: ReadonlyMap<string, string>): string {
  const def = kindDef(col.kind);
  if (!def.picks) return def.label;
  const picked = col.picks.map((id) => names.get(id)).filter((n): n is string => !!n);
  if (picked.length === 0) return col.picks.length === 0 ? def.label : def.short;
  return picked.length <= 2 ? picked.join(" + ") : `${picked[0]} +${picked.length - 1}`;
}

/** API pages of the Stream Scope reads when a column shows New or About to graduate. */
export const SCOPE_STREAM_PAGES = 3;

/** API pages of the Live feed Scope reads: the newest alerts, enough to fill its alert columns. */
export const SCOPE_PAGES = 5;

/** API pages of each picked model's calls (GET /curated?model=, 12 a page). */
export const SCOPE_MODEL_PAGES = 2;

/** The live tick's limit on tokens per request (LIVE_TICK_MAX_TOKENS in the API). */
const MAX_TICK_TOKENS = 30;

/**
 * A card's market cap now, else at its scan: how close a coin still on its curve is to graduating,
 * since a launchpad curve completes at a set market cap (Pump.fun's at about $70-90K).
 */
const mcapOf = (card: Card): number => nowReading(card) ?? card.snapshot.marketCapUsd ?? 0;

/** Each column's rows, by column id. */
export type ScopeColumns = Record<ScopeColumn, Card[]>;

export const emptyColumns = (cols: readonly { id: ScopeColumn }[]): ScopeColumns =>
  Object.fromEntries(cols.map((c) => [c.id, []]));

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

/** When the card's alert was made: a model's call time, else the filter match's. */
const alertTime = (card: Card): number =>
  Date.parse(card.curated && card.kind !== "match" ? card.curated.alertedAt : card.matchedAt);

/** Several models' calls as one list, newest first, each token once (its newest call). */
export function mergeCalls(lists: readonly (readonly Card[])[]): Card[] {
  const all = lists.flat().sort((a, b) => (alertTime(b) || 0) - (alertTime(a) || 0));
  const seen = new Set<string>();
  return all.filter((c) => !seen.has(c.tokenId) && (seen.add(c.tokenId), true));
}

/** What the board's columns are made from. */
export interface ScopeSources {
  /** The Live feed: your filters' alerts and the followed models' calls, newest first. */
  feed: readonly Card[];
  /** The Stream's graduated tokens, newest first. */
  graduated: readonly Card[];
  /** The Stream's tokens still on their curve. */
  stream?: readonly Card[];
  /** Picked models' own calls, by model id, newest first. */
  modelCalls?: ReadonlyMap<string, readonly Card[]>;
}

/**
 * The board's columns, each keeping its source's newest-first order. An alert whose coin has
 * graduated moves to the Graduated column when the board has one (user ask 2026-10-18), in its
 * coin's place there or by its alert time, keeping its filter or model marker; a column with
 * `keepGraduated` keeps it too. Without a Graduated column it stays where it is. A token both a
 * filter and a model alerted on sits only on the side that alerted first (user ask 2026-10-19); a
 * tie, or no times to go by, goes to the filters' side. New and About to graduate hold the Stream's
 * tokens still on their curve (user ask 2026-10-19), New newest first and About to graduate by
 * market cap, biggest (closest to graduating) first.
 */
export function splitScope(
  columns: readonly (ScopeColumnSpec & { keepGraduated?: boolean })[],
  src: ScopeSources,
): ScopeColumns {
  const out = emptyColumns(columns);
  const gradTokens = new Set(src.graduated.map((c) => c.tokenId));
  const hasGrad = columns.some((c) => c.kind === "graduated");
  const fresh: Card[] = [];
  const seen = new Set<string>();
  for (const card of src.stream ?? []) {
    if (seen.has(card.tokenId) || cardGraduated(card, gradTokens)) continue;
    seen.add(card.tokenId);
    fresh.push(card);
  }
  const soon = [...fresh].sort((a, b) => mcapOf(b) - mcapOf(a));

  const sourceOf = (col: ScopeColumnSpec): readonly Card[] => {
    switch (col.kind) {
      case "filters":
        return src.feed.filter((c) => c.kind === "match");
      case "filter":
        return src.feed.filter((c) => c.kind === "match" && !!c.filter && col.picks.includes(c.filter.id));
      case "models":
        return src.feed.filter((c) => c.curated !== null);
      case "model":
        return mergeCalls(col.picks.map((id) => src.modelCalls?.get(id) ?? []));
      default:
        return [];
    }
  };
  const moved = new Map<string, Card>();
  // Each token's first alert on each side, among the cards the board's columns would show.
  const first = new Map<string, { filters: number | null; models: number | null }>();
  const lists = new Map<ScopeColumn, Card[]>();
  for (const col of columns) {
    if (!isAlertKind(col.kind)) continue;
    const list: Card[] = [];
    for (const card of sourceOf(col)) {
      if (hasGrad && cardGraduated(card, gradTokens)) {
        if (!moved.has(card.tokenId)) moved.set(card.tokenId, card);
        if (!col.keepGraduated) continue;
      }
      list.push(card);
      const t = first.get(card.tokenId) ?? { filters: null, models: null };
      if (isFilterSide(col.kind)) t.filters = Math.min(t.filters ?? Infinity, timeOf(card.matchedAt));
      else t.models = Math.min(t.models ?? Infinity, timeOf(card.curated?.alertedAt));
      first.set(card.tokenId, t);
    }
    lists.set(col.id, list);
  }
  const filtersFirst = (tokenId: string) => {
    const t = first.get(tokenId);
    return t?.filters != null && (t.models == null || t.filters <= t.models);
  };

  let graduated: Card[] = [...src.graduated];
  if (moved.size > 0) {
    // Each row with the time it sorts by: an entry's own, which its alert takes over in place.
    const rows = src.graduated.map((c) => {
      const alert = moved.get(c.tokenId);
      moved.delete(c.tokenId);
      return { card: alert ?? c, at: Date.parse(c.matchedAt) };
    });
    for (const card of moved.values()) rows.push({ card, at: alertTime(card) });
    graduated = rows.sort((a, b) => (b.at || 0) - (a.at || 0)).map((r) => r.card);
  }

  for (const col of columns) {
    if (col.kind === "new") out[col.id] = [...fresh];
    else if (col.kind === "soon") out[col.id] = [...soon];
    else if (col.kind === "graduated") out[col.id] = [...graduated];
    else {
      const filterSide = isFilterSide(col.kind);
      out[col.id] = (lists.get(col.id) ?? []).filter((c) => filtersFirst(c.tokenId) === filterSide);
    }
  }
  return out;
}

/** The ids on each column, in order: what a paused board holds still. */
export type ScopeFrame = Record<ScopeColumn, string[]>;

export function frameOf(cols: ScopeColumns): ScopeFrame {
  return Object.fromEntries(Object.entries(cols).map(([id, cards]) => [id, cards.map((c) => c.id)]));
}

/**
 * The last card seen for each id, as `holdFrame` reads it: the cards on the board now and, while
 * it holds still, the ones its frame still draws. Anything else is dropped, so a board left open
 * on the Stream all day doesn't keep every card it ever showed (audit 2026-10-23, WB-2).
 */
export function keptCards(
  last: ReadonlyMap<string, Card>,
  visible: readonly Card[],
  frame: ScopeFrame | null,
): Map<string, Card> {
  const out = new Map<string, Card>();
  if (frame)
    for (const ids of Object.values(frame))
      for (const id of ids) {
        const card = last.get(id);
        if (card) out.set(id, card);
      }
  for (const c of visible) out.set(c.id, c);
  return out;
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
  for (const cards of Object.values(fresh)) for (const c of cards) byId.set(c.id, c);
  const cols: ScopeColumns = {};
  // A column the frame drew empty (its data hadn't arrived yet, say), or one added since, fills in
  // as it comes: there are no rows on screen to shift, so nothing to hold back.
  const open = (col: ScopeColumn) => (frame[col]?.length ?? 0) === 0;
  for (const col of Object.keys(fresh)) {
    if (open(col)) {
      cols[col] = [...fresh[col]!];
      continue;
    }
    cols[col] = [];
    for (const id of frame[col]!) {
      const card = byId.get(id) ?? last.get(id);
      if (card) cols[col].push(card);
    }
  }
  // New rows: one a column hasn't drawn yet (a folded alert counts once).
  const waiting = new Set<string>();
  for (const col of Object.keys(fresh)) {
    if (open(col)) continue;
    const drawn = new Set(frame[col]);
    for (const c of fresh[col]!) if (!drawn.has(c.id)) waiting.add(c.id);
  }
  return { cols, pending: waiting.size };
}

/**
 * The tokens to keep "Now" seconds old, within the live tick's limit: each column's top rows in
 * turn, newest first, so what is on screen first stays live.
 */
export function scopeTickIds(cols: ScopeColumns): string[] {
  const out = new Set<string>();
  const lists = Object.values(cols);
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth && out.size < MAX_TICK_TOKENS; i++) {
    for (const list of lists) {
      const card = list[i];
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

/** Rows a minute old or more read their age in minutes, so their clock moves at the Cards view's pace. */
export const ROW_SLOW_CLOCK_MS = 15_000;

/**
 * The clock a row is drawn with: the board's own (5 s) while its age reads in seconds, then one
 * that moves every ROW_SLOW_CLOCK_MS, so the memoized rows past their first minute re-render a
 * third as often instead of every row on every tick (audit 2026-10-23, WB-3).
 */
export function rowClock(now: number, card: Card): number {
  const at = Date.parse(card.kind === "match" ? card.matchedAt : (card.curated?.alertedAt ?? card.matchedAt));
  const slow = Math.floor(now / ROW_SLOW_CLOCK_MS) * ROW_SLOW_CLOCK_MS;
  return Number.isFinite(at) && slow - at >= 60_000 ? slow : now;
}

/** Board-wide reasons to hold still. Only a pointer resting on it or a scrolled list say "Paused". */
export type ScopeHold = "pointer" | "touch" | "scroll";

/** A sideways swipe this far, and mostly sideways, moves a phone's board one column over. */
const SWIPE_MIN_PX = 50;

/**
 * Which way a finger's swipe moves a phone's board: 1 to the next column, -1 to the one before,
 * 0 when it was a tap or mostly a scroll up or down.
 */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}
