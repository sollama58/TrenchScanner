import type { PanelPrefs } from "./tooltip";
import type { OverlaySettings, OverlayToken } from "./types";
import { verdictFor, type RowVerdict } from "./verdict";

/**
 * The alerts the panel lists, and the ones the worker counts and notifies (user ask 2026-10-25):
 * a model call or filter match the reader's settings show, and, with the option on, not a coin
 * whose newest scan fails the safety screen.
 */
export function panelAlerts(
  tokens: readonly OverlayToken[],
  settings: OverlaySettings,
  prefs: Pick<PanelPrefs, "hideUnsafe">,
): { token: OverlayToken; verdict: RowVerdict }[] {
  return tokens
    .map((token) => ({ token, verdict: verdictFor(token, settings) }))
    .filter(({ verdict }) => verdict.ring !== null && verdict.ring !== "risk")
    .filter(({ token }) => !(prefs.hideUnsafe && token.safety?.passed === false));
}

/** A notification's title and line for a new alert: the coin and what alerted it, and its cap. */
export function alertNotice(token: OverlayToken): { title: string; message: string } {
  const coin = token.symbol ?? `${token.mint.slice(0, 4)}…${token.mint.slice(-4)}`;
  const call = token.modelCalls[0];
  const match = token.filterMatches[0];
  const by = call
    ? `${call.name ?? call.model}${call.calibratedPct === null ? "" : ` ${Math.round(call.calibratedPct)}%`}`
    : (match?.filterName ?? "Alert");
  const mcap = token.liveMcapUsd ?? token.stats?.marketCapUsd ?? null;
  const unsafe = token.safety?.passed === false ? " · fails the safety screen" : "";
  return {
    title: `${coin} · ${by}`,
    message: `${mcap === null ? "New alert" : `Market cap ${usdShort(mcap)}`}${unsafe}`,
  };
}

function usdShort(value: number): string {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}
