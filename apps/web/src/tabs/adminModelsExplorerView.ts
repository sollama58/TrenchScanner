/** The Models explorer's window and formatting helpers (AdminModelsExplorer.tsx). */

export const EXPLORER_PRESETS = [
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "3h", minutes: 180 },
  { label: "6h", minutes: 360 },
  { label: "12h", minutes: 720 },
  { label: "24h", minutes: 1440 },
  { label: "3d", minutes: 4320 },
  { label: "7d", minutes: 10080 },
] as const;

export type ExplorerWindow =
  { kind: "preset"; minutes: number } | { kind: "range"; since: string; until: string };

export function explorerPath(win: ExplorerWindow, model: string | null): string {
  const params = new URLSearchParams();
  if (win.kind === "preset") params.set("minutes", String(win.minutes));
  else {
    params.set("since", win.since);
    params.set("until", win.until);
  }
  if (model) params.set("model", model);
  return `/admin/models/performance?${params.toString()}`;
}

/** A bucket's start in the reader's time: the clock alone inside a day, the date too beyond. */
export function bucketLabel(iso: string, windowMinutes: number, timeZone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
  if (windowMinutes <= 24 * 60) return time;
  const day = d.toLocaleDateString([], { month: "short", day: "numeric", timeZone });
  return `${day} ${time}`;
}

/** Seconds as "45s" or "1m 30s". */
export function seconds(v: number | null | undefined): string {
  if (v === null || v === undefined) return "–";
  if (v < 60) return `${Math.round(v)}s`;
  const m = Math.floor(v / 60);
  const s = Math.round(v - m * 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * The change from the prior span: in points for a rate ("pts"), as a relative change for a count
 * ("%"), as a difference for a multiple ("x").
 */
export function delta(now: number | null, before: number | null, unit: "pts" | "%" | "x"): string {
  if (now === null || before === null) return "no prior";
  if (unit === "%") {
    if (before === 0) return now === 0 ? "±0%" : "new";
    const d = Math.round(((now - before) / before) * 100);
    return `${d > 0 ? "+" : ""}${d}%`;
  }
  const d = now - before;
  const text = unit === "x" ? d.toFixed(2) : d.toFixed(1);
  if (Number(text) === 0) return unit === "x" ? "±0" : "±0 pts";
  return `${d > 0 ? "+" : ""}${text}${unit === "x" ? "" : " pts"}`;
}
