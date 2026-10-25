import { FLAG_IDS, FLAG_LABELS } from "./settings";
import type { FlagId, OverlaySettings, OverlayToken } from "./types";

/**
 * What one tracked row shows, decided from the token and the reader's settings. Pure, so the
 * content script and the tests agree on it.
 */
export type RingKind = "model" | "filter" | "both" | "risk";
export type FlagLevel = "ok" | "mid" | "hi";

export interface FlagReading {
  id: FlagId;
  label: string;
  short: string;
  text: string;
  level: FlagLevel;
}

export interface RowVerdict {
  ring: RingKind | null;
  badge: string | null;
  flags: FlagReading[];
  /** Some enabled flag is past its threshold, whatever ring is shown. */
  risky: boolean;
}

export function readFlag(id: FlagId, token: OverlayToken, threshold: number | null): FlagReading | null {
  const value = token.stats?.[id];
  if (value === null || value === undefined) return null;
  const meta = FLAG_LABELS[id];
  if (typeof value === "boolean") {
    return {
      id,
      label: meta.label,
      short: meta.short,
      text: value ? "Yes" : "No",
      level: value ? "hi" : "ok",
    };
  }
  const text = meta.unit === "%" ? `${Math.round(value)}%` : String(value);
  let level: FlagLevel = "ok";
  if (threshold !== null) {
    if (value > threshold) level = "hi";
    else if (value > threshold * 0.6) level = "mid";
  }
  return { id, label: meta.label, short: meta.short, text, level };
}

export function verdictFor(token: OverlayToken, settings: OverlaySettings): RowVerdict {
  const flags = FLAG_IDS.flatMap((id) => {
    const pref = settings.flags[id];
    if (!pref.on) return [];
    const reading = readFlag(id, token, pref.threshold);
    return reading ? [reading] : [];
  });
  const risky = flags.some((f) => f.level === "hi");

  const aiOk = !settings.rings.aiBuyOnly || token.ai?.decision === "buy";
  const model = settings.rings.modelAlerts && aiOk ? token.modelCalls[0] : undefined;
  const filter = settings.rings.filterMatches ? token.filterMatches[0] : undefined;

  let ring: RingKind | null = null;
  let badge: string | null = null;
  if (model && filter) ring = "both";
  else if (model) ring = "model";
  else if (filter) ring = "filter";
  else if (settings.rings.riskRing && risky) ring = "risk";

  if (model) {
    const odds = model.calibratedPct === null ? "" : ` ${Math.round(model.calibratedPct)}%`;
    badge = `${(model.name ?? model.model).slice(0, 14)}${odds}`;
  } else if (filter) {
    badge = filter.filterName.slice(0, 18);
  } else if (ring === "risk") {
    const worst = flags.find((f) => f.level === "hi")!;
    badge = `${worst.short} ${worst.text}`;
  }
  return { ring, badge, flags, risky };
}
