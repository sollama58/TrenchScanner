import type {
  LighthouseDimension,
  LighthouseHistory,
  LighthouseHistoryBucket,
  LighthouseLabelTally,
  LighthouseSums,
} from "./api";
import { halfHour } from "./format";

/**
 * What the Lighthouse tab can draw from the history's sums: the metric catalogue, the chart
 * panels a reader composes from it (and the defaults), and the CSV of what is on screen. Pure
 * functions, so the tab stays a thin view and this is what the tests cover.
 */

/** A metric's scale: rates share a 0-100% axis, counts their own, a return is signed. */
export type Unit = "pct" | "count" | "ret";

export interface Metric {
  id: MetricId;
  label: string;
  /** The group the picker lists it under. */
  group: "Screened field" | "Model calls" | "TokenSage";
  unit: Unit;
  /** A goal line drawn with it: the 2x and 4x targets. */
  target?: "2x" | "4x";
  value: (s: LighthouseSums) => number | null;
}

const rate = (won: number, of: number) => (of > 0 ? (won / of) * 100 : null);
const mean = (sum: number, n: number) => (n > 0 ? sum / n : null);

export const METRICS = [
  {
    id: "field2x",
    label: "2x rate, screened field",
    group: "Screened field",
    unit: "pct",
    target: "2x",
    value: (s) => rate(s.screened.won2x, s.screened.graded),
  },
  {
    id: "field4x",
    label: "4x rate, screened field",
    group: "Screened field",
    unit: "pct",
    target: "4x",
    value: (s) => rate(s.screened.won4x, s.screened.graded),
  },
  {
    id: "field10x",
    label: "10x rate, screened field",
    group: "Screened field",
    unit: "pct",
    value: (s) => rate(s.screened.won10x, s.screened.tenXGraded),
  },
  {
    id: "fieldReturn",
    label: "Avg return, screened field",
    group: "Screened field",
    unit: "ret",
    value: (s) => mean(s.screened.returnSum, s.screened.returnN),
  },
  {
    id: "fieldCalls",
    label: "Decision moments",
    group: "Screened field",
    unit: "count",
    value: (s) => s.screened.calls,
  },
  {
    id: "fieldGraded",
    label: "Screened tokens graded",
    group: "Screened field",
    unit: "count",
    value: (s) => s.screened.graded,
  },
  {
    id: "calls2x",
    label: "2x rate, model calls",
    group: "Model calls",
    unit: "pct",
    target: "2x",
    value: (s) => rate(s.alerts.won2x, s.alerts.graded),
  },
  {
    id: "calls4x",
    label: "4x rate, model calls",
    group: "Model calls",
    unit: "pct",
    target: "4x",
    value: (s) => rate(s.alerts.won4x, s.alerts.graded),
  },
  {
    id: "calls10x",
    label: "10x rate, model calls",
    group: "Model calls",
    unit: "pct",
    // Over the calls whose 10x verdict is in, like the screened side: a clean 2x winner whose
    // 10x hour is still open is not a miss yet. Older sums without the count fall back to graded.
    value: (s) => rate(s.alerts.won10x, s.alerts.tenXGraded ?? s.alerts.graded),
  },
  {
    id: "callsReturn",
    label: "Avg return, model calls",
    group: "Model calls",
    unit: "ret",
    value: (s) => mean(s.alerts.returnSum, s.alerts.returnN),
  },
  { id: "calls", label: "Model calls", group: "Model calls", unit: "count", value: (s) => s.alerts.total },
  {
    id: "callsGraded",
    label: "Model calls graded",
    group: "Model calls",
    unit: "count",
    value: (s) => s.alerts.graded,
  },
  {
    id: "coinsRead",
    label: "Coins read",
    group: "TokenSage",
    unit: "count",
    value: (s) => s.reads.described,
  },
  {
    id: "failedReads",
    label: "Failed reads",
    group: "TokenSage",
    unit: "count",
    value: (s) => s.reads.failed,
  },
  {
    id: "storyConfidence",
    label: "Story confidence",
    group: "TokenSage",
    unit: "pct",
    value: (s) => {
      const m = mean(s.reads.referentConfidenceSum, s.reads.referentConfidenceN);
      return m === null ? null : m * 100;
    },
  },
  {
    id: "xFit",
    label: "X link fit",
    group: "TokenSage",
    unit: "pct",
    value: (s) => {
      const m = mean(s.reads.xFitSum, s.reads.xFitN);
      return m === null ? null : m * 100;
    },
  },
  {
    id: "copycatShare",
    label: "Copycat share",
    group: "TokenSage",
    unit: "pct",
    value: (s) => rate(s.reads.copiesRecent, s.reads.copiesAnswered),
  },
  {
    id: "newsShare",
    label: "In-the-news share",
    group: "TokenSage",
    unit: "pct",
    value: (s) => rate(s.reads.trendMatched, s.reads.trendAnswered),
  },
] as const satisfies readonly (Omit<Metric, "id"> & { id: string })[];

export type MetricId = (typeof METRICS)[number]["id"];
export const METRIC_IDS = METRICS.map((m) => m.id) as MetricId[];
export const metricById = (id: MetricId): Metric => METRICS.find((m) => m.id === id) as Metric;

/** A chart can carry two scales (left and right axis); a third metric unit won't fit. */
export const MAX_UNITS = 2;
/** Series a chart can tell apart by color (--series-1..5). */
export const MAX_SERIES = 5;

export type ChartKind = "line" | "bars";

/** What a breakdown panel draws for each label of the chosen dimension. */
export type BreakdownMode = "count" | "share" | "calls" | "rate2x";

export type Panel =
  | { id: string; kind: ChartKind; metrics: MetricId[] }
  | { id: string; kind: ChartKind; breakdown: BreakdownMode; dimension: LighthouseDimension };

export const BREAKDOWN_MODES: { id: BreakdownMode; label: string; unit: Unit; kind: ChartKind }[] = [
  { id: "count", label: "Coins read", unit: "count", kind: "bars" },
  { id: "share", label: "Share of coins read", unit: "pct", kind: "bars" },
  { id: "calls", label: "Model calls", unit: "count", kind: "bars" },
  { id: "rate2x", label: "2x rate of model calls", unit: "pct", kind: "line" },
];

export const DIMENSIONS: { id: LighthouseDimension; label: string }[] = [
  { id: "category", label: "Narrative" },
  { id: "subcategory", label: "Sub-narrative" },
  { id: "flag", label: "Flag raised" },
  { id: "referentKind", label: "What the coin is about" },
  { id: "referentSupport", label: "Where the story comes from" },
  { id: "xVerdict", label: "X link verdict" },
  { id: "pairKind", label: "Trades against" },
  { id: "copy", label: "Original or copy" },
  { id: "news", label: "In the news" },
];

export const WINDOWS: { days: number; label: string; long: string }[] = [
  { days: 7, label: "7d", long: "7 days" },
  { days: 30, label: "30d", long: "30 days" },
  { days: 90, label: "90d", long: "90 days" },
  { days: 365, label: "1y", long: "a year" },
  { days: 0, label: "All", long: "everything kept" },
];

export const BUCKETS: { id: LighthouseHistoryBucket; label: string }[] = [
  { id: "hour", label: "Hourly" },
  { id: "day", label: "Daily" },
  { id: "week", label: "Weekly" },
];

/** Hourly points past a month are too many to read (the API refuses them too). */
export const bucketAllowed = (bucket: LighthouseHistoryBucket, days: number) =>
  bucket !== "hour" || (days > 0 && days <= 30);

export const defaultBucketFor = (days: number): LighthouseHistoryBucket =>
  days > 0 && days <= 7 ? "hour" : days > 0 && days <= 90 ? "day" : "week";

let nextId = 0;
export const panelId = () => `p${Date.now().toString(36)}${(nextId++).toString(36)}`;

/** The charts a first visit opens with: the goals, the money, the models against the field, the narratives. */
export function defaultPanels(): Panel[] {
  return [
    { id: panelId(), kind: "line", metrics: ["field2x", "field4x", "field10x"] },
    { id: panelId(), kind: "bars", metrics: ["fieldReturn", "callsReturn"] },
    { id: panelId(), kind: "line", metrics: ["calls2x", "field2x"] },
    { id: panelId(), kind: "bars", metrics: ["coinsRead", "calls"] },
    { id: panelId(), kind: "bars", breakdown: "count", dimension: "category" },
    { id: panelId(), kind: "line", breakdown: "rate2x", dimension: "category" },
  ];
}

/** Ready-made charts the "Add chart" menu offers. */
export const PRESETS: { label: string; make: () => Panel }[] = [
  {
    label: "Hit rates of the screened field",
    make: () => ({ id: panelId(), kind: "line", metrics: ["field2x", "field4x", "field10x"] }),
  },
  {
    label: "Average return on the exit plan",
    make: () => ({ id: panelId(), kind: "bars", metrics: ["fieldReturn", "callsReturn"] }),
  },
  {
    label: "Model calls against the field",
    make: () => ({ id: panelId(), kind: "line", metrics: ["calls2x", "field2x"] }),
  },
  {
    label: "How many calls the models make",
    make: () => ({ id: panelId(), kind: "bars", metrics: ["calls", "fieldCalls"] }),
  },
  {
    label: "Coins read and model calls",
    make: () => ({ id: panelId(), kind: "bars", metrics: ["coinsRead", "calls"] }),
  },
  {
    label: "Story confidence and X fit",
    make: () => ({ id: panelId(), kind: "line", metrics: ["storyConfidence", "xFit"] }),
  },
  {
    label: "Copycats and the news",
    make: () => ({ id: panelId(), kind: "line", metrics: ["copycatShare", "newsShare"] }),
  },
  {
    label: "Breakdown: coins read",
    make: () => ({ id: panelId(), kind: "bars", breakdown: "count", dimension: "category" }),
  },
  {
    label: "Breakdown: share of coins read",
    make: () => ({ id: panelId(), kind: "bars", breakdown: "share", dimension: "category" }),
  },
  {
    label: "Breakdown: model calls",
    make: () => ({ id: panelId(), kind: "bars", breakdown: "calls", dimension: "category" }),
  },
  {
    label: "Breakdown: 2x rate of model calls",
    make: () => ({ id: panelId(), kind: "line", breakdown: "rate2x", dimension: "category" }),
  },
  { label: "Empty chart", make: () => ({ id: panelId(), kind: "line", metrics: [] }) },
];

/** Whether two panels draw the same thing: the same breakdown of the same dimension, or the same metrics in the same order. */
export const samePanel = (a: Panel, b: Panel): boolean => {
  if ("breakdown" in a || "breakdown" in b)
    return "breakdown" in a && "breakdown" in b && a.breakdown === b.breakdown && a.dimension === b.dimension;
  return a.metrics.length === b.metrics.length && a.metrics.every((m, i) => m === b.metrics[i]);
};

/** Whether a chart like `p` is already on the page, so adding it again would only repeat it. */
export const hasPanel = (panels: Panel[], p: Panel) => panels.some((q) => samePanel(q, p));

/** The units a set of metrics needs, in the order they first appear (left axis first). */
export const unitsOf = (ids: MetricId[]): Unit[] => {
  const out: Unit[] = [];
  for (const id of ids) {
    const u = metricById(id).unit;
    if (!out.includes(u)) out.push(u);
  }
  return out;
};

/** Whether `id` can join `ids` on one chart: a free color, and at most two scales. */
export const canAdd = (ids: MetricId[], id: MetricId) =>
  ids.length < MAX_SERIES && unitsOf([...ids, id]).length <= MAX_UNITS;

export interface Series {
  id: string;
  label: string;
  unit: Unit;
  values: (number | null)[];
  /** The color slot, 1-5, or 0 for the neutral "other". */
  slot: number;
  target?: number;
}

/** Graded calls under which a label's 2x rate for a bucket is withheld rather than drawn. */
export const MIN_GRADED = 5;

/** The series a metrics panel draws from the history. */
export function metricSeries(
  h: LighthouseHistory,
  ids: MetricId[],
  targets: { hitRate2xPct: number; hitRate4xPct: number },
): Series[] {
  return ids.map((id, i) => {
    const m = metricById(id);
    return {
      id,
      label: m.label,
      unit: m.unit,
      values: h.series.map((s) => m.value(s)),
      slot: i + 1,
      target: m.target === "2x" ? targets.hitRate2xPct : m.target === "4x" ? targets.hitRate4xPct : undefined,
    };
  });
}

/** The series a breakdown panel draws: one per top label, then "other". */
export function breakdownSeries(h: LighthouseHistory, mode: BreakdownMode): Series[] {
  const labels = [...h.labels.top, "other"];
  const unit = BREAKDOWN_MODES.find((m) => m.id === mode)!.unit;
  const pick = (t: LighthouseLabelTally | undefined, total: number): number | null => {
    if (mode === "count") return t?.count ?? 0;
    if (mode === "calls") return t?.alerts ?? 0;
    if (mode === "share") return total > 0 ? ((t?.count ?? 0) / total) * 100 : null;
    return t && t.graded >= MIN_GRADED ? (t.won2x / t.graded) * 100 : null;
  };
  const series = labels.map((label, i) => ({
    id: label,
    label: words(label),
    unit,
    slot: label === "other" ? 0 : i + 1,
    values: h.labels.buckets.map((b) => {
      // A share is of the coins read, not of the labels: a coin can carry several labels of a
      // dimension or none. Older API builds don't send the coins read; their label sum stands in.
      const total = b.described ?? b.rows.reduce((s, r) => s + r.count, 0);
      return pick(
        b.rows.find((r) => r.label === label),
        total,
      );
    }),
  }));
  // "other" only earns a place when it holds something.
  return series.filter((s) => s.slot !== 0 || s.values.some((v) => v !== null && v !== 0));
}

/** TokenSage's codes ("x_link_reused", "about_this_coin") as words. */
export const words = (code: string) => code.replace(/[_-]+/g, " ").replace("/", " › ").trim();

export const dimensionLabel = (id: LighthouseDimension) => DIMENSIONS.find((d) => d.id === id)?.label ?? id;

export function panelTitle(p: Panel): string {
  if ("breakdown" in p) {
    const mode = BREAKDOWN_MODES.find((m) => m.id === p.breakdown)!.label;
    const dim = dimensionLabel(p.dimension);
    return `${mode} by ${dim.toLowerCase()}`;
  }
  if (p.metrics.length === 0) return "Empty chart";
  return p.metrics.map((id) => metricById(id).label).join(" · ");
}

const PANELS_KEY = "trenchscanner.lighthouse.panels.v1";

/** The reader's charts, as this browser last saved them; nothing saved (or junk) means the defaults. */
export function loadPanels(): Panel[] {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    if (!raw) return defaultPanels();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultPanels();
    // Breakdowns saved before each chart carried its own dimension split by narrative.
    const panels = parsed
      .map((p: unknown) =>
        typeof p === "object" && p !== null && "breakdown" in p && !("dimension" in p)
          ? { ...p, dimension: "category" }
          : p,
      )
      .filter(isPanel);
    return panels.length ? panels : defaultPanels();
  } catch {
    return defaultPanels();
  }
}

export function savePanels(panels: Panel[]) {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
  } catch {
    // Private mode or a full store: the charts simply don't persist.
  }
}

export function isPanel(v: unknown): v is Panel {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.id !== "string" || (p.kind !== "line" && p.kind !== "bars")) return false;
  if ("breakdown" in p)
    return BREAKDOWN_MODES.some((m) => m.id === p.breakdown) && DIMENSIONS.some((d) => d.id === p.dimension);
  return (
    Array.isArray(p.metrics) &&
    p.metrics.every((m) => (METRIC_IDS as string[]).includes(m as string)) &&
    p.metrics.length <= MAX_SERIES &&
    unitsOf(p.metrics as MetricId[]).length <= MAX_UNITS
  );
}

/** Short tick labels and full readout labels for a bucket's start. */
export function bucketLabel(iso: string, bucket: LighthouseHistoryBucket): { short: string; full: string } {
  const t = new Date(iso);
  if (bucket === "hour") {
    return {
      short: t.toLocaleTimeString([], { hour: "numeric", minute: halfHour(t) }),
      full: t.toLocaleString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: halfHour(t),
      }),
    };
  }
  // Day and week buckets start at 00:00 UTC (Mondays for weeks), so their labels are UTC dates:
  // in local time a browser west of UTC would show the day before.
  const utc = { timeZone: "UTC" } as const;
  const day = t.toLocaleDateString([], { ...utc, month: "short", day: "numeric" });
  if (bucket === "day")
    return {
      short: day,
      full: t.toLocaleDateString([], {
        ...utc,
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    };
  return {
    short: day,
    full: `Week of ${t.toLocaleDateString([], { ...utc, month: "short", day: "numeric", year: "numeric" })}`,
  };
}

/** The window's sums as a CSV, one row per bucket, every metric a column, plus the raw counts. */
export function historyCsv(h: LighthouseHistory): string {
  const head = [
    "bucket_start_utc",
    ...METRICS.map((m) => m.id),
    "screened_calls",
    "screened_graded",
    "screened_won2x",
    "screened_won4x",
    "screened_won10x",
    "coins_read",
    "failed_reads",
    "model_calls",
    "model_calls_graded",
    "model_calls_won2x",
    "model_calls_won4x",
  ];
  const cell = (v: number | null) => (v === null ? "" : Number.isInteger(v) ? String(v) : v.toFixed(2));
  const rows = h.series.map((s) =>
    [
      s.at,
      ...METRICS.map((m) => cell(m.value(s))),
      s.screened.calls,
      s.screened.graded,
      s.screened.won2x,
      s.screened.won4x,
      s.screened.won10x,
      s.reads.described,
      s.reads.failed,
      s.alerts.total,
      s.alerts.graded,
      s.alerts.won2x,
      s.alerts.won4x,
    ].join(","),
  );
  return [head.join(","), ...rows].join("\n") + "\n";
}

/** A KPI's change against the span before the window, in the metric's own unit. */
export function delta(m: Metric, now: LighthouseSums, before: LighthouseSums | null): number | null {
  if (!before) return null;
  const a = m.value(now);
  const b = m.value(before);
  return a === null || b === null ? null : a - b;
}

/** The yardstick a narrative is read against: every graded model call in the window, pooled. */
export interface NarrativeBaseline {
  /** Average return under the exit plan across every call with one, or null with none. */
  avgReturn: number | null;
  /** Share of graded calls that reached 2x, or null with none graded. */
  rate2x: number | null;
  graded: number;
}

/**
 * The all-narrative average from the per-narrative tallies, uncategorized included, so a
 * narrative's relative strength is its figure minus this one: what it adds over picking calls
 * at random from the same window.
 */
export function narrativeBaseline(
  rows: { graded: number; won2x: number; returnN: number; returnSum: number }[],
): NarrativeBaseline {
  let graded = 0;
  let won2x = 0;
  let returnN = 0;
  let returnSum = 0;
  for (const r of rows) {
    graded += r.graded;
    won2x += r.won2x;
    returnN += r.returnN;
    returnSum += r.returnSum;
  }
  return { avgReturn: mean(returnSum, returnN), rate2x: rate(won2x, graded), graded };
}

/** The relative bar's reach either side of the average: the smallest step that fits the widest gap. */
export function relativeScale(gaps: (number | null)[]): number {
  const widest = Math.max(0, ...gaps.map((g) => (g === null ? 0 : Math.abs(g))));
  return [10, 25, 50, 100, 200].find((s) => widest <= s) ?? 200;
}

/** A gap in percentage points with its sign: +12 pts, -8 pts, 0 pts. */
export function signedPts(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "–";
  const r = Math.round(value);
  return `${r > 0 ? "+" : r < 0 ? "-" : ""}${Math.abs(r)} pts`;
}
