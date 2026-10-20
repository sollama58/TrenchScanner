/**
 * Which event flags the token chart draws (Customize › Chart events). The chart builds one flag per
 * moment in ChartCard; this decides which of those are drawn. apps/api/src/feedAppearance.ts holds
 * the same kind names and defaults.
 */

/** Every kind ChartCard can put on a flag. */
export const CHART_EVENT_KINDS = ["alert", "screen", "filter", "model", "graduation", "scanned"] as const;
export type ChartEventKind = (typeof CHART_EVENT_KINDS)[number];

/** Kinds that can be collapsed to their earliest flag. Passed screen, graduation and scanned are one each. */
export const CHART_EVENT_FIRST_KINDS = ["alert", "filter", "model"] as const;
export type ChartEventFirstKind = (typeof CHART_EVENT_FIRST_KINDS)[number];

/** How Customize lists them. Passed screen is the one that starts off. */
export const CHART_EVENT_KIND_OPTIONS: readonly { kind: ChartEventKind; label: string }[] = [
  { kind: "alert", label: "Alert" },
  { kind: "screen", label: "Passed screen" },
  { kind: "filter", label: "Filter match" },
  { kind: "model", label: "Model call" },
  { kind: "graduation", label: "Graduation" },
  { kind: "scanned", label: "Scanned" },
];

/** Shown by default: everything ChartCard emits except the screen pass. */
export const DEFAULT_CHART_EVENT_KINDS: readonly ChartEventKind[] = CHART_EVENT_KINDS.filter(
  (k) => k !== "screen",
);

/** Only the first filter and the first model. Alerts are not collapsed unless the reader asks. */
export const DEFAULT_CHART_EVENT_FIRST: readonly ChartEventFirstKind[] = ["filter", "model"];

const FIRST_LABEL: Record<ChartEventFirstKind, string> = {
  alert: "Alert",
  filter: "Filter",
  model: "Model",
};

export const CHART_EVENT_FIRST_OPTIONS: readonly { kind: ChartEventFirstKind; label: string }[] =
  CHART_EVENT_FIRST_KINDS.map((kind) => ({ kind, label: FIRST_LABEL[kind] }));

/**
 * The kind of a flag ChartCard builds.
 * A filter match is the flag labeled "Alert". "Model alert" and each model's name are model calls.
 * The screen pass, graduation and a utility scan are their own kinds. Anything else is an alert.
 */
export function chartFlagKind(
  label: string,
  source: "primary" | "screen" | "model",
  cardKind?: "match" | "curated" | "stream",
): ChartEventKind {
  if (source === "screen" || label === "Passed screen") return "screen";
  if (label === "Graduated") return "graduation";
  if (label === "Scanned") return "scanned";
  if (source === "model" || label === "Model alert") return "model";
  if (source === "primary" && cardKind === "match") return "filter";
  return "alert";
}

/**
 * A saved list of kinds. A missing list, or one with a value that is not a kind (or a repeat), is
 * the default. A real list is returned in `allowed` order, so an empty list stays empty.
 */
export function chartEventChoice<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: readonly T[],
): T[] {
  if (!Array.isArray(raw) || new Set(raw).size !== raw.length) return [...fallback];
  if (raw.some((k) => typeof k !== "string" || !(allowed as readonly string[]).includes(k)))
    return [...fallback];
  const picked = new Set(raw as T[]);
  return allowed.filter((k) => picked.has(k));
}

export interface ChartEventPrefs {
  /** Kinds that may be drawn. */
  kinds: readonly ChartEventKind[];
  /** Of these kinds, only the earliest flag is drawn. */
  first: readonly ChartEventFirstKind[];
}

/**
 * The flags to draw, earliest first. A kind that is off is dropped (no line, no flag). When
 * only-first is on for a kind, later flags of that kind are dropped. Alerts stay, unless alert
 * itself is in `first` or the alert kind is off.
 */
export function chartEventsToDraw<T extends { t: number; kind: ChartEventKind }>(
  events: readonly T[],
  prefs: ChartEventPrefs,
): T[] {
  const shown = new Set(prefs.kinds);
  const firstOf = new Set<string>(prefs.first);
  const seen = new Set<string>();
  const indexed = events.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => a.e.t - b.e.t || a.i - b.i);
  const out: T[] = [];
  for (const { e } of indexed) {
    if (!shown.has(e.kind)) continue;
    if (firstOf.has(e.kind)) {
      if (seen.has(e.kind)) continue;
      seen.add(e.kind);
    }
    out.push(e);
  }
  return out;
}
