import { useSyncExternalStore } from "react";
import { put, type Card } from "./api";
import { DEFAULT_SCOPE_CHIPS, SCOPE_CHIP_IDS, type ScopeChip } from "./scopeChips";
import { cardReadings, newestStats, nowReading, recordedPeakOf, socialLinks } from "./components/AlertCard";
import { cardOutcome, outcomeResult } from "./outcome";
import { change } from "./format";
import type { ScopeColumn } from "./scope";

/**
 * Scope's own settings (user ask 2026-10-18): what each column lets through and how the rows look,
 * kept apart from the Cards view's Customize. Saved to the account (PUT /settings/scope, user ask
 * 2026-10-19) so they follow the user to every device, and kept in localStorage too so this device
 * applies them at once, before the settings load, and keeps them if a save fails.
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
  /**
   * Your filters and Models: keep alerts whose coin has graduated here too. Off, they show only in
   * the Graduated column, with their filter or model marker (user ask 2026-10-18).
   */
  showGraduated: boolean;
  /** Models column: only high-conviction calls. */
  highOnly: boolean;
  /** Models column: only these models' calls (empty: every model you follow). */
  models: string[];
  /** Your filters column: only these filters' alerts (empty: every filter). */
  filters: string[];
}

export type { ScopeChip };

const SCOPE_CHIPS_ALL: readonly ScopeChip[] = SCOPE_CHIP_IDS;

/** How tightly rows sit: padding, gaps and the space between rows. */
export type ScopeDensity = "compact" | "cozy" | "roomy";
/** Rows as separate cards with space between them, or one flat list. */
export type ScopeLayout = "cards" | "list";
export type ScopeSize = "s" | "m" | "l";
/** How the data chips are drawn. */
export type ScopeChipStyle = "soft" | "outline" | "plain";

export interface ScopeDisplay {
  /** Chips under each row. */
  chips: ScopeChip[];
  showName: boolean;
  showSource: boolean;
  showSocials: boolean;
  /** The cards' creator fee icon beside the age (user ask 2026-10-19: on by default). */
  showFees: boolean;
  /** Clicking the ticker copies the contract address instead of opening the coin (user ask 2026-10-19). */
  tickerCopiesCa: boolean;
  /** The card footer's trade sites and Dex/Pump links, as small text links after the socials. */
  showTradeLinks: boolean;
  showAt: boolean;
  showPeak: boolean;
  showResult: boolean;
  showAge: boolean;
  density: ScopeDensity;
  layout: ScopeLayout;
  imageSize: ScopeSize;
  textSize: ScopeSize;
  chipStyle: ScopeChipStyle;
  /** Market cap green when up from the alert, red when down; plain otherwise. */
  colorMcap: boolean;
  /** Ages under a minute in green, so the newest rows stand out. */
  highlightNew: boolean;
  /** Hold the board still while a pointer or finger is on it. */
  pauseOnHover: boolean;
  /** Columns left off the board. */
  hiddenColumns: ScopeColumn[];
  /** The Stream's New and About to graduate columns in place of Your filters and Models. */
  stream: boolean;
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
  showGraduated: false,
  highOnly: false,
  models: [],
  filters: [],
};

export const DEFAULT_SCOPE_SETTINGS: ScopeSettings = {
  display: {
    chips: DEFAULT_SCOPE_CHIPS,
    showName: true,
    showSource: false,
    showSocials: true,
    showFees: true,
    tickerCopiesCa: true,
    showTradeLinks: false,
    showAt: false,
    showPeak: false,
    showResult: false,
    showAge: true,
    density: "roomy",
    layout: "cards",
    imageSize: "m",
    textSize: "m",
    chipStyle: "soft",
    colorMcap: true,
    highlightNew: true,
    pauseOnHover: true,
    hiddenColumns: [],
    stream: false,
  },
  columns: {
    filters: DEFAULT_COLUMN_FILTER,
    models: DEFAULT_COLUMN_FILTER,
    new: DEFAULT_COLUMN_FILTER,
    soon: DEFAULT_COLUMN_FILTER,
    graduated: DEFAULT_COLUMN_FILTER,
  },
};

const SCOPE_SETTINGS_KEY = "ts-scope-settings";
const COLUMNS: ScopeColumn[] = ["filters", "models", "new", "soon", "graduated"];
const SOCIALS = ["any", "x", "website", "either", "both"] as const;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const strings = (v: unknown): string[] =>
  // Within what the account stores (apps/api/src/scopeSettings.ts).
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length <= 128).slice(0, 50) : [];

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
    showGraduated: bool(r.showGraduated, d.showGraduated),
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
  const chipIds = SCOPE_CHIPS_ALL;
  const pickOf = <T extends string>(v: unknown, opts: readonly T[], fallback: T): T =>
    opts.includes(v as T) ? (v as T) : fallback;
  return {
    display: {
      chips: Array.isArray(disp.chips)
        ? chipIds.filter((c) => (disp.chips as unknown[]).includes(c))
        : d.chips,
      showName: bool(disp.showName, d.showName),
      showSource: bool(disp.showSource, d.showSource),
      showSocials: bool(disp.showSocials, d.showSocials),
      showFees: bool(disp.showFees, d.showFees),
      tickerCopiesCa: bool(disp.tickerCopiesCa, d.tickerCopiesCa),
      showTradeLinks: bool(disp.showTradeLinks, d.showTradeLinks),
      showAt: bool(disp.showAt, d.showAt),
      showPeak: bool(disp.showPeak, d.showPeak),
      showResult: bool(disp.showResult, d.showResult),
      showAge: bool(disp.showAge, d.showAge),
      // Saved before densities: "Compact rows" on reads as compact.
      density: pickOf(
        disp.density,
        ["compact", "cozy", "roomy"],
        disp.compact === true ? "compact" : d.density,
      ),
      layout: pickOf(disp.layout, ["cards", "list"], d.layout),
      imageSize: pickOf(disp.imageSize, ["s", "m", "l"], d.imageSize),
      textSize: pickOf(disp.textSize, ["s", "m", "l"], d.textSize),
      chipStyle: pickOf(disp.chipStyle, ["soft", "outline", "plain"], d.chipStyle),
      colorMcap: bool(disp.colorMcap, d.colorMcap),
      highlightNew: bool(disp.highlightNew, d.highlightNew),
      pauseOnHover: bool(disp.pauseOnHover, d.pauseOnHover),
      hiddenColumns: Array.isArray(disp.hiddenColumns)
        ? keepOneColumn(COLUMNS.filter((c) => (disp.hiddenColumns as unknown[]).includes(c)))
        : d.hiddenColumns,
      stream: bool(disp.stream, d.stream),
    },
    columns: {
      filters: normalizeFilter(cols.filters),
      models: normalizeFilter(cols.models),
      new: normalizeFilter(cols.new),
      soon: normalizeFilter(cols.soon),
      graduated: normalizeFilter(cols.graduated),
    },
  };
}

/**
 * Never every column of a board, with Stream off or on: it would be empty with no way to tell
 * why. Graduated, on both boards, comes back.
 */
function keepOneColumn(hidden: ScopeColumn[]): ScopeColumn[] {
  const all = (ids: ScopeColumn[]) => ids.every((c) => hidden.includes(c));
  return all(["filters", "models", "graduated"]) || all(["new", "soon", "graduated"])
    ? hidden.filter((c) => c !== "graduated")
    : hidden;
}

let current: ScopeSettings = load();
const listeners = new Set<() => void>();
/** Bumped on every change here, so a settings load that started before it doesn't undo it. */
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = 0;
const SAVE_DELAY_MS = 600;

function load(): ScopeSettings {
  try {
    const raw = localStorage.getItem(SCOPE_SETTINGS_KEY);
    return normalizeScopeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_SCOPE_SETTINGS;
  }
}

function show(next: ScopeSettings) {
  current = next;
  try {
    localStorage.setItem(SCOPE_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Private mode or blocked storage: the settings still apply for this visit.
  }
  for (const l of listeners) l();
}

function save(next: ScopeSettings) {
  version++;
  show(next);
  if (timer) clearTimeout(timer);
  // Quick clicks and typed filters go in one save.
  timer = setTimeout(() => {
    timer = null;
    void saveToAccount();
  }, SAVE_DELAY_MS);
}

async function saveToAccount() {
  inflight++;
  try {
    await put<{ scopeSettings: ScopeSettings }>("/settings/scope", current);
  } catch {
    // Kept on this device either way; the next change tries the account again.
  } finally {
    inflight--;
  }
}

// Another window of the dashboard changed them: show the same here. Only shown - that window
// saves them to the account.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== SCOPE_SETTINGS_KEY) return;
    current = load();
    for (const l of listeners) l();
  });
}

/**
 * Forgets this device's copy when its account signs out: an account with none saved takes this
 * browser's (adoptScopeSettings), so the next one to sign in here would otherwise get these.
 */
export function resetScopeSettings(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  version++;
  current = DEFAULT_SCOPE_SETTINGS;
  try {
    localStorage.removeItem(SCOPE_SETTINGS_KEY);
  } catch {
    // Storage blocked: nothing was kept there either.
  }
  for (const l of listeners) l();
}

/** The local version now; pass it to adoptScopeSettings with what a settings load returned. */
export function scopeSettingsVersion(): number {
  return version;
}

/**
 * Takes the account's saved settings (from GET /settings), unless this device changed them since
 * that request went out or still has a save on the way. An API build without them sends nothing.
 * An account with none yet (null) takes this browser's, if they were ever changed from the defaults.
 */
export function adoptScopeSettings(saved: unknown, sinceVersion: number): void {
  if (saved === undefined || version !== sinceVersion || timer !== null || inflight > 0) return;
  if (saved === null) {
    if (JSON.stringify(current) !== JSON.stringify(DEFAULT_SCOPE_SETTINGS)) void saveToAccount();
    return;
  }
  const next = normalizeScopeSettings(saved);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  show(next);
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
    (f.showGraduated ? 1 : 0) +
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
 * Whether a card is within a column's "hide rows older than" cutoff: the one filter a coin the Pro
 * wallet holds still answers to (heldTokens.ts).
 */
export function withinMaxAge(card: Card, f: ScopeColumnFilter, now: number): boolean {
  if (f.maxAgeMin === null) return true;
  const at = Date.parse(card.curated && card.kind !== "match" ? card.curated.alertedAt : card.matchedAt);
  return !Number.isFinite(at) || (now - at) / 60_000 <= f.maxAgeMin;
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
  if (!withinMaxAge(card, f, now)) return false;
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
