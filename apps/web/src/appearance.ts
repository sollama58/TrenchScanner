import { useSyncExternalStore, type CSSProperties } from "react";
import { put, type CardField, type FeedAppearance } from "./api";

/**
 * How the Live feed looks: theme, colors, spacing, columns and which card fields show. Saved to
 * the wallet's account (PUT /settings/appearance) so it follows the user to every device, and kept
 * in localStorage too so this device paints it at once, before the settings load, and keeps it if
 * a save fails. apps/api/src/feedAppearance.ts holds the same names and bounds.
 */

export const DEFAULT_APPEARANCE: FeedAppearance = {
  theme: "auto",
  accent: null,
  mine: null,
  win: null,
  loss: null,
  density: "cozy",
  columns: 0,
  cardWidth: "normal",
  phoneColumns: 1,
  textSize: 100,
  corners: "rounded",
  avatar: "normal",
  sourceStripe: true,
  learningNote: true,
  hidden: [],
};

/** Every hideable card field, grouped as the Settings tab lists them. */
export const CARD_FIELD_GROUPS: { title: string; fields: { id: CardField; label: string }[] }[] = [
  {
    title: "Header",
    fields: [
      { id: "tokenName", label: "Token name" },
      { id: "time", label: "Time since alert" },
      { id: "modelPill", label: "Model and confidence" },
      { id: "conviction", label: "High conviction" },
      { id: "calibrated", label: "≈2x rate" },
      { id: "result", label: "Result mark (✓ / ✕)" },
    ],
  },
  {
    title: "Price boxes",
    fields: [
      { id: "alert", label: "Alert" },
      { id: "now", label: "Now" },
      { id: "peak", label: "Peak" },
      { id: "ath", label: "ATH under Peak" },
    ],
  },
  {
    title: "Stat tiles",
    fields: [
      { id: "vol", label: "Vol 24h" },
      { id: "holders", label: "Holders" },
      { id: "age", label: "Age" },
      { id: "top10", label: "Top 10" },
      { id: "fresh", label: "Fresh" },
      { id: "empty", label: "Empty" },
      { id: "snipers", label: "Snipers" },
      { id: "dev", label: "Dev" },
    ],
  },
  {
    title: "Extras",
    fields: [
      { id: "reasons", label: "Model reasons" },
      { id: "mint", label: "Copy mint button" },
      { id: "links", label: "Dex / Pump / RugCheck links" },
    ],
  },
];

const CARD_FIELDS = new Set<string>(CARD_FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.id)));

/** Ready-made looks. Each keeps the user's theme and colors and sets the rest. */
export const PRESETS: { id: string; label: string; hint: string; look: Partial<FeedAppearance> }[] = [
  { id: "default", label: "Default", hint: "The standard cards", look: {} },
  {
    id: "compact",
    label: "Compact",
    hint: "Tighter cards, more on screen",
    look: { density: "compact", cardWidth: "narrow", textSize: 95, avatar: "small", hidden: ["reasons"] },
  },
  {
    id: "minimal",
    label: "Minimal",
    hint: "Price boxes and the key wallet checks",
    look: {
      density: "compact",
      hidden: [
        "tokenName",
        "calibrated",
        "ath",
        "vol",
        "holders",
        "age",
        "top10",
        "snipers",
        "reasons",
        "mint",
      ],
      learningNote: false,
    },
  },
  {
    id: "big",
    label: "Big and clear",
    hint: "Larger text and images, roomy spacing",
    look: { density: "roomy", cardWidth: "wide", textSize: 115, avatar: "large", corners: "round" },
  },
  {
    id: "wall",
    label: "Trading wall",
    hint: "Four columns of dense cards on desktop, two on phones",
    look: {
      density: "compact",
      columns: 4,
      phoneColumns: 2,
      textSize: 90,
      corners: "square",
      hidden: ["tokenName", "reasons", "calibrated"],
    },
  },
];

/** Swatches offered beside the color picker. */
export const SWATCHES = [
  "#8b5cf6",
  "#3b82f6",
  "#06b6d4",
  "#22c55e",
  "#eab308",
  "#f97316",
  "#ef4444",
  "#ec4899",
];

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const intIn = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
const hex = (value: unknown): string | null =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;

/** Anything read back (localStorage, an API build ahead or behind) as a valid appearance. */
export function normalizeAppearance(raw: unknown): FeedAppearance {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_APPEARANCE;
  return {
    theme: pick(r.theme, ["auto", "dark", "light"] as const, d.theme),
    accent: hex(r.accent),
    mine: hex(r.mine),
    win: hex(r.win),
    loss: hex(r.loss),
    density: pick(r.density, ["compact", "cozy", "roomy"] as const, d.density),
    columns: intIn(r.columns, 0, 4, d.columns),
    cardWidth: pick(r.cardWidth, ["narrow", "normal", "wide"] as const, d.cardWidth),
    phoneColumns: intIn(r.phoneColumns, 1, 2, d.phoneColumns),
    textSize: intIn(r.textSize, 85, 125, d.textSize),
    corners: pick(r.corners, ["square", "rounded", "round"] as const, d.corners),
    avatar: pick(r.avatar, ["small", "normal", "large"] as const, d.avatar),
    sourceStripe: typeof r.sourceStripe === "boolean" ? r.sourceStripe : d.sourceStripe,
    learningNote: typeof r.learningNote === "boolean" ? r.learningNote : d.learningNote,
    hidden: Array.isArray(r.hidden)
      ? [...new Set(r.hidden.filter((f): f is CardField => typeof f === "string" && CARD_FIELDS.has(f)))]
      : [],
  };
}

/** A preset applied on top of the default, keeping the user's theme and colors. */
export function withPreset(current: FeedAppearance, look: Partial<FeedAppearance>): FeedAppearance {
  const { theme, accent, mine, win, loss } = current;
  return normalizeAppearance({ ...DEFAULT_APPEARANCE, ...look, theme, accent, mine, win, loss });
}

/** Whether two appearances look the same (hidden fields in any order). */
export function sameAppearance(a: FeedAppearance, b: FeedAppearance): boolean {
  const key = (x: FeedAppearance) => JSON.stringify({ ...x, hidden: [...x.hidden].sort() });
  return key(a) === key(b);
}

// ---- The store ----

/** index.html reads this key too, to set the theme before the first paint. */
export const APPEARANCE_KEY = "ts.feedAppearance";
const SAVE_DELAY_MS = 600;

export type SaveState = { state: "idle" | "saving" | "saved" } | { state: "error"; message: string };

function readLocal(): FeedAppearance {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    return raw ? normalizeAppearance(JSON.parse(raw)) : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function writeLocal(a: FeedAppearance) {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(a));
  } catch {
    // Storage blocked or full: the account copy still has it.
  }
}

let current: FeedAppearance = readLocal();
let saveState: SaveState = { state: "idle" };
/** Bumped by every local change, so a settings load that started before it doesn't undo it. */
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Puts the theme on the page root: "auto" follows the OS. */
function applyTheme(a: FeedAppearance) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (a.theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = a.theme;
}
applyTheme(current);

export function useAppearance(): FeedAppearance {
  return useSyncExternalStore(subscribe, () => current);
}

export function useAppearanceSave(): SaveState {
  return useSyncExternalStore(subscribe, () => saveState);
}

/** The local version now; pass it to adoptAppearance with what a settings load returned. */
export function appearanceVersion(): number {
  return version;
}

/**
 * Takes the account's saved appearance (from GET /settings), unless this device changed it since
 * that request went out or still has a save on the way. An API build without it sends nothing.
 */
export function adoptAppearance(saved: unknown, sinceVersion: number): void {
  if (saved === undefined || version !== sinceVersion || timer !== null || inflight > 0) return;
  const next = normalizeAppearance(saved);
  if (sameAppearance(next, current)) return;
  current = next;
  writeLocal(current);
  applyTheme(current);
  emit();
}

/** Changes the appearance: shown at once, kept on this device, saved to the account shortly. */
export function setAppearance(change: Partial<FeedAppearance>): void {
  current = normalizeAppearance({ ...current, ...change });
  version++;
  writeLocal(current);
  applyTheme(current);
  saveState = { state: "saving" };
  emit();
  if (timer) clearTimeout(timer);
  // Sliders and quick clicks settle first; the whole appearance goes in one save.
  timer = setTimeout(() => {
    timer = null;
    void save();
  }, SAVE_DELAY_MS);
}

async function save() {
  const sending = current;
  const sentAt = version;
  inflight++;
  try {
    await put<{ appearance: FeedAppearance }>("/settings/appearance", sending);
    if (version === sentAt) saveState = { state: "saved" };
  } catch (e) {
    // Kept on this device either way; the next change tries the account again.
    if (version === sentAt)
      saveState = { state: "error", message: e instanceof Error ? e.message : String(e) };
  } finally {
    inflight--;
    emit();
  }
}

/** Set by the Live tab's Customize button so the Settings tab opens at the appearance section. */
export const openAt = { appearance: false };

// ---- Applying it ----

const COLOR_SLOTS = ["win", "loss", "accent", "mine"] as const;

/**
 * The attributes and CSS variables the feed's card grid takes. Only what differs from the default
 * is set, so the default look is exactly the stylesheet's own. Colors go in as the theme's
 * variables, with the text shades mixed toward the theme's ink so they read in dark and light.
 */
export function feedGridProps(a: FeedAppearance): Record<string, string | CSSProperties | undefined> {
  const style: Record<string, string> = {};
  for (const slot of COLOR_SLOTS) {
    const c = a[slot];
    if (!c) continue;
    if (slot === "win") {
      style["--good"] = c;
      style["--good-ink"] = `color-mix(in srgb, ${c} 72%, var(--ink))`;
      style["--good-wash"] = `color-mix(in srgb, ${c} 12%, transparent)`;
    } else if (slot === "loss") {
      style["--bad"] = c;
      style["--bad-ink"] = `color-mix(in srgb, ${c} 72%, var(--ink))`;
      style["--bad-wash"] = `color-mix(in srgb, ${c} 12%, transparent)`;
    } else if (slot === "accent") {
      style["--brand-a"] = c;
      style["--brand-ink"] = `color-mix(in srgb, ${c} 65%, var(--ink))`;
    } else {
      style["--series-1"] = c;
    }
  }
  if (a.textSize !== 100) style["--card-zoom"] = String(a.textSize / 100);
  const d = DEFAULT_APPEARANCE;
  return {
    "data-density": a.density !== d.density ? a.density : undefined,
    "data-cols": a.columns !== d.columns ? String(a.columns) : undefined,
    "data-width": a.columns === 0 && a.cardWidth !== d.cardWidth ? a.cardWidth : undefined,
    "data-phone-cols": a.phoneColumns !== d.phoneColumns ? String(a.phoneColumns) : undefined,
    "data-corners": a.corners !== d.corners ? a.corners : undefined,
    "data-avatar": a.avatar !== d.avatar ? a.avatar : undefined,
    "data-stripe": a.sourceStripe ? undefined : "off",
    style: style as CSSProperties,
  };
}
