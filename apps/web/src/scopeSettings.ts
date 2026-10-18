import { useSyncExternalStore } from "react";
import type { Card, CardField } from "./api";
import { cardReadings, newestStats, nowReading, recordedPeakOf, socialLinks } from "./components/AlertCard";
import { cardOutcome, outcomeResult } from "./outcome";
import { change } from "./format";
import type { ScopeColumn } from "./scope";

/**
 * Scope's own settings (user ask 2026-10-18): what each column lets through and how the rows look,
 * kept apart from the Cards view's Customize and saved in this browser.
 */

/** One column's filters. Null on a bound means it is off. */
export interface ScopeColumnFilter {
  /** Market cap now (the alert's while there is no live reading), in USD. */
  mcapMin: number | null;
  mcapMax: number | null;
  /** Hide rows older than this many minutes. */
  maxAgeMin: number | null;
  minHolders: number | null;
  maxTop10Pct: number | null;
  maxFreshPct: number | null;
  /** Top holders who were among the launch's first 25 buyers. */
  maxSnipers: number | null;
  maxLinkedPct: number | null;
  /** Only rows up at least this much from the alert (Peak). */
  minPeakPct: number | null;
  /** Which links a coin must have. */
  socials: "any" | "x" | "website" | "either" | "both";
  /** Hide alerts that missed 2x or stopped out. */
  hideMissed: boolean;
  /** Models column: only high-conviction calls. */
  highOnly: boolean;
  /** Models column: only these models' calls (empty: every model you follow). */
  models: string[];
  /** Your filters column: only these filters' alerts (empty: every filter). */
  filters: string[];
}

export type ScopeChip = "holders" | "top10" | "fresh" | "snipers" | "linked";

export const SCOPE_CHIPS: { id: ScopeChip; label: string }[] = [
  { id: "holders", label: "Holders" },
  { id: "top10", label: "Top 10 %" },
  { id: "fresh", label: "Fresh wallets" },
  { id: "snipers", label: "Snipers" },
  { id: "linked", label: "Linked wallets" },
];

export interface ScopeDisplay {
  /** Chips under each row. */
  chips: ScopeChip[];
  showName: boolean;
  showSource: boolean;
  showSocials: boolean;
  showAt: boolean;
  showPeak: boolean;
  showResult: boolean;
  /** Tighter rows with a smaller image. */
  compact: boolean;
  /** Hold the board still while a pointer or finger is on it. */
  pauseOnHover: boolean;
  /** Columns left off the board. */
  hiddenColumns: ScopeColumn[];
}

export interface ScopeSettings {
  display: ScopeDisplay;
  columns: Record<ScopeColumn, ScopeColumnFilter>;
}

export const DEFAULT_COLUMN_FILTER: ScopeColumnFilter = {
  mcapMin: null,
  mcapMax: null,
  maxAgeMin: null,
  minHolders: null,
  maxTop10Pct: null,
  maxFreshPct: null,
  maxSnipers: null,
  maxLinkedPct: null,
  minPeakPct: null,
  socials: "any",
  hideMissed: false,
  highOnly: false,
  models: [],
  filters: [],
};

export const DEFAULT_SCOPE_SETTINGS: ScopeSettings = {
  display: {
    chips: SCOPE_CHIPS.map((c) => c.id),
    showName: true,
    showSource: true,
    showSocials: true,
    showAt: true,
    showPeak: true,
    showResult: true,
    compact: false,
    pauseOnHover: true,
    hiddenColumns: [],
  },
  columns: {
    filters: DEFAULT_COLUMN_FILTER,
    models: DEFAULT_COLUMN_FILTER,
    graduated: DEFAULT_COLUMN_FILTER,
  },
};

const SCOPE_SETTINGS_KEY = "ts-scope-settings";
const COLUMNS: ScopeColumn[] = ["filters", "models", "graduated"];
const SOCIALS = ["any", "x", "website", "either", "both"] as const;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, 50) : [];

function normalizeFilter(raw: unknown): ScopeColumnFilter {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_COLUMN_FILTER;
  return {
    mcapMin: num(r.mcapMin),
    mcapMax: num(r.mcapMax),
    maxAgeMin: num(r.maxAgeMin),
    minHolders: num(r.minHolders),
    maxTop10Pct: num(r.maxTop10Pct),
    maxFreshPct: num(r.maxFreshPct),
    maxSnipers: num(r.maxSnipers),
    maxLinkedPct: num(r.maxLinkedPct),
    minPeakPct: num(r.minPeakPct),
    socials: SOCIALS.includes(r.socials as never) ? (r.socials as ScopeColumnFilter["socials"]) : d.socials,
    hideMissed: bool(r.hideMissed, d.hideMissed),
    highOnly: bool(r.highOnly, d.highOnly),
    models: strings(r.models),
    filters: strings(r.filters),
  };
}

/** Saved settings as this build reads them: unknown or broken fields fall back to the defaults. */
export function normalizeScopeSettings(raw: unknown): ScopeSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const disp = (r.display && typeof r.display === "object" ? r.display : {}) as Record<string, unknown>;
  const cols = (r.columns && typeof r.columns === "object" ? r.columns : {}) as Record<string, unknown>;
  const d = DEFAULT_SCOPE_SETTINGS.display;
  const chipIds = SCOPE_CHIPS.map((c) => c.id);
  return {
    display: {
      chips: Array.isArray(disp.chips)
        ? chipIds.filter((c) => (disp.chips as unknown[]).includes(c))
        : d.chips,
      showName: bool(disp.showName, d.showName),
      showSource: bool(disp.showSource, d.showSource),
      showSocials: bool(disp.showSocials, d.showSocials),
      showAt: bool(disp.showAt, d.showAt),
      showPeak: bool(disp.showPeak, d.showPeak),
      showResult: bool(disp.showResult, d.showResult),
      compact: bool(disp.compact, d.compact),
      pauseOnHover: bool(disp.pauseOnHover, d.pauseOnHover),
      // Never every column: the board would be empty with no way to tell why.
      hiddenColumns: Array.isArray(disp.hiddenColumns)
        ? COLUMNS.filter((c) => (disp.hiddenColumns as unknown[]).includes(c)).slice(0, COLUMNS.length - 1)
        : d.hiddenColumns,
    },
    columns: {
      filters: normalizeFilter(cols.filters),
      models: normalizeFilter(cols.models),
      graduated: normalizeFilter(cols.graduated),
    },
  };
}

let current: ScopeSettings = load();
const listeners = new Set<() => void>();

function load(): ScopeSettings {
  try {
    const raw = localStorage.getItem(SCOPE_SETTINGS_KEY);
    return normalizeScopeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_SCOPE_SETTINGS;
  }
}

function save(next: ScopeSettings) {
  current = next;
  try {
    localStorage.setItem(SCOPE_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Private mode or blocked storage: the settings still apply for this visit.
  }
  for (const l of listeners) l();
}

export function useScopeSettings(): ScopeSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export function setScopeDisplay(change: Partial<ScopeDisplay>): void {
  save(normalizeScopeSettings({ ...current, display: { ...current.display, ...change } }));
}

export function setColumnFilter(col: ScopeColumn, change: Partial<ScopeColumnFilter>): void {
  save(
    normalizeScopeSettings({
      ...current,
      columns: { ...current.columns, [col]: { ...current.columns[col], ...change } },
    }),
  );
}

export function resetColumnFilter(col: ScopeColumn): void {
  setColumnFilter(col, DEFAULT_COLUMN_FILTER);
}

export function resetScopeDisplay(): void {
  setScopeDisplay(DEFAULT_SCOPE_SETTINGS.display);
}

/** How many of a column's filters are on, for the badge on its filter icon. */
export function activeFilterCount(f: ScopeColumnFilter): number {
  const bounds = [
    f.mcapMin,
    f.mcapMax,
    f.maxAgeMin,
    f.minHolders,
    f.maxTop10Pct,
    f.maxFreshPct,
    f.maxSnipers,
    f.maxLinkedPct,
    f.minPeakPct,
  ].filter((v) => v !== null).length;
  return (
    bounds +
    (f.socials !== "any" ? 1 : 0) +
    (f.hideMissed ? 1 : 0) +
    (f.highOnly ? 1 : 0) +
    (f.models.length > 0 ? 1 : 0) +
    (f.filters.length > 0 ? 1 : 0)
  );
}

/** The model names a card's call carries (every model that called it, first call first). */
export function cardModelNames(card: Card): string[] {
  const c = card.curated;
  if (!c) return [];
  if (c.calledBy && c.calledBy.length > 0) return c.calledBy.map((m) => m.modelName ?? "Model");
  return [c.modelName ?? "Model"];
}

/**
 * Whether a card gets through a column's filters at `now`. A reading the card doesn't have never
 * hides it: a filter only judges what is known.
 */
export function passesColumnFilter(card: Card, f: ScopeColumnFilter, col: ScopeColumn, now: number): boolean {
  const alertMcap = card.snapshot.marketCapUsd;
  const nowMcap = nowReading(card) ?? alertMcap;
  if (f.mcapMin !== null && nowMcap < f.mcapMin) return false;
  if (f.mcapMax !== null && nowMcap > f.mcapMax) return false;
  if (f.maxAgeMin !== null) {
    const at = Date.parse(card.curated && card.kind !== "match" ? card.curated.alertedAt : card.matchedAt);
    if (Number.isFinite(at) && (now - at) / 60_000 > f.maxAgeMin) return false;
  }
  const t = newestStats(card);
  if (f.minHolders !== null && t.holders != null && t.holders < f.minHolders) return false;
  if (f.maxTop10Pct !== null && t.top10Pct != null && t.top10Pct > f.maxTop10Pct) return false;
  if (f.maxFreshPct !== null || f.maxSnipers !== null || f.maxLinkedPct !== null) {
    const r = cardReadings(card, "newest");
    if (f.maxFreshPct !== null && r.freshPct != null && r.freshPct > f.maxFreshPct) return false;
    if (f.maxSnipers !== null && r.snipers && r.snipers.count > f.maxSnipers) return false;
    if (f.maxLinkedPct !== null && r.linkedPct != null && r.linkedPct > f.maxLinkedPct) return false;
  }
  if (f.minPeakPct !== null) {
    const move = change(alertMcap, nowReading(card));
    const recorded = recordedPeakOf(card).pct;
    const peak = Math.max(recorded ?? 0, move ?? 0);
    if (peak < f.minPeakPct) return false;
  }
  if (f.socials !== "any") {
    const links = new Set(socialLinks(card.token).map((l) => l.key));
    const x = links.has("x");
    const web = links.has("web");
    const ok =
      f.socials === "x" ? x : f.socials === "website" ? web : f.socials === "both" ? x && web : x || web;
    if (!ok) return false;
  }
  if (f.hideMissed && outcomeResult(cardOutcome(card, now)) === "fail") return false;
  if (col === "models") {
    const c = card.curated;
    if (f.highOnly && !(c?.tier === "high" || c?.calledBy?.some((m) => m.tier === "high"))) return false;
    if (f.models.length > 0 && !cardModelNames(card).some((n) => f.models.includes(n))) return false;
  }
  if (col === "filters" && f.filters.length > 0) {
    if (!card.filter || !f.filters.includes(card.filter.name)) return false;
  }
  return true;
}

/** Scope's display settings as the row's hidden-field set (the same shape as Customize's). */
export function scopeHideSet(d: ScopeDisplay): ReadonlySet<CardField> {
  const out = new Set<CardField>();
  if (!d.showName) out.add("tokenName");
  if (!d.showSource) {
    out.add("modelPill");
    out.add("conviction");
  }
  if (!d.showSocials) out.add("socials");
  if (!d.showAt) out.add("alert");
  if (!d.showPeak) out.add("peak");
  if (!d.showResult) out.add("result");
  for (const c of SCOPE_CHIPS) if (!d.chips.includes(c.id)) out.add(c.id);
  return out;
}
