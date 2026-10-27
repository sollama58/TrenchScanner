import { MAP_LABELS, type MapLine, type PillPart } from "./tooltip";
import type { FlagId, OverlayBubbleTotals, OverlaySettings, OverlayToken } from "./types";
import {
  alertCall,
  alertMatch,
  devReading,
  firstAlert,
  readFlag,
  type FlagLevel,
  type RowVerdict,
} from "./verdict";

/** One piece of a pill's text, coloured by its flag's level when it has one. */
export interface PillSegment {
  text: string;
  level?: FlagLevel;
}

function usd(value: number): string {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${Math.round(value / 1e3)}K`;
  return `$${Math.round(value)}`;
}

function since(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/**
 * A pill's text from the parts the reader picked (shared/tooltip.ts), each part left out when the
 * coin has nothing for it. `totals` are the coin's bubble map totals, undefined until read.
 */
export function pillSegments(
  parts: readonly PillPart[],
  token: OverlayToken,
  verdict: RowVerdict,
  settings: OverlaySettings,
  totals?: OverlayBubbleTotals | null,
  now = Date.now(),
): PillSegment[] {
  const model = verdict.ring === "model" || verdict.ring === "both" ? alertCall(token) : undefined;
  const filter = verdict.ring === "filter" || verdict.ring === "both" ? alertMatch(token) : undefined;
  // Change and age count from the reader's first alert, as the tooltip's "Alerted at" does.
  const first = firstAlert(token);
  const nowMcap = token.liveMcapUsd ?? token.stats?.marketCapUsd ?? null;
  const out: PillSegment[] = [];
  for (const part of parts) {
    if (part === "signal") {
      if (model) out.push({ text: (model.name ?? model.model).slice(0, 14) });
      else if (filter) out.push({ text: filter.filterName.slice(0, 18) });
      else if (verdict.ring === "risk") {
        const worst = verdict.flags.find((f) => f.level === "hi");
        if (worst) out.push({ text: `${worst.short} ${worst.text}`, level: "hi" });
      }
    } else if (part === "odds") {
      if (model?.calibratedPct !== null && model?.calibratedPct !== undefined)
        out.push({ text: `${Math.round(model.calibratedPct)}%` });
    } else if (part === "change") {
      const at = first?.mcapUsd ?? null;
      if (at && nowMcap !== null) {
        const pct = Math.round(((nowMcap - at) / at) * 100);
        out.push({ text: `${pct >= 0 ? "+" : ""}${pct}%`, level: pct >= 0 ? "ok" : "hi" });
      }
    } else if (part === "mcap") {
      if (nowMcap !== null) out.push({ text: usd(nowMcap) });
    } else if (part === "age") {
      if (first) out.push({ text: since(first.at, now) });
    } else if (part === "holders") {
      const count = token.stats?.holderCount;
      if (count !== null && count !== undefined) out.push({ text: `${count}h` });
    } else if (part === "dev") {
      const dev = devReading(token);
      if (dev?.text && token.dev?.record) out.push({ text: dev.short, level: dev.level });
    } else if (part.startsWith("flag:")) {
      const id = part.slice(5) as FlagId;
      const flag = readFlag(id, token, settings.flags[id].threshold);
      if (flag) out.push({ text: `${flag.short} ${flag.text}`, level: flag.level });
    } else if (part.startsWith("map:")) {
      const key = part.slice(4) as MapLine;
      const value = totals?.[key];
      if (value !== null && value !== undefined)
        out.push({ text: `${MAP_LABELS[key].short} ${Math.round(value)}%` });
    }
  }
  return out;
}
