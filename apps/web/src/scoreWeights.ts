import { useSyncExternalStore } from "react";
import { api, type ScoreWeightsInfo } from "./api";

/**
 * The composite score's current weights (GET /config/score), fetched once per page and shared by
 * every card's tooltip and the score explainer. They adapt every few hours on the server
 * (scoring/scoreWeights.ts), so a long-open tab re-reads them now and then.
 */
const REFRESH_MS = 30 * 60_000;
/** What the score started from, shown until the first read lands (scoring/scorer.ts). */
const FALLBACK: ScoreWeightsInfo = {
  weights: { momentum: 0.45, freshness: 0.3, holderQuality: 0.1, narrative: 0.15 },
  adoptedAt: null,
  scale: { p10: 60, p90: 88, sample: 0 },
  history: [],
};

let current: ScoreWeightsInfo = FALLBACK;
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): void {
  if (inFlight || Date.now() - fetchedAt < REFRESH_MS) return;
  inFlight = api<ScoreWeightsInfo>("/config/score")
    .then((info) => {
      current = info;
      fetchedAt = Date.now();
      listeners.forEach((l) => l());
    })
    .catch(() => {
      // Keep what we have; try again on the next subscriber after a short wait.
      fetchedAt = Date.now() - REFRESH_MS + 60_000;
    })
    .finally(() => {
      inFlight = null;
    });
}

export function useScoreWeights(): ScoreWeightsInfo {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      load();
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}

const pct = (w: number) => `${Math.round(w * 100)}%`;

/** The weights in one line: "momentum 45% · freshness 30% · holders 10% · narrative 15%". */
export function weightsLine(w: ScoreWeightsInfo["weights"]): string {
  return `momentum ${pct(w.momentum)} · freshness ${pct(w.freshness)} · holders ${pct(w.holderQuality)} · narrative ${pct(w.narrative)}`;
}

/** Where the score's color comes from when the server hasn't sent its scale (see FALLBACK). */
export const DEFAULT_SCORE_SCALE = { p10: 60, p90: 88, sample: 0 };

/**
 * Where a score sits between recent alerts' 10th percentile (0) and 90th (1), clamped: the Score
 * tile's red-to-green position. Null when there's no score.
 */
export function scoreTone(score: number | null, scale = DEFAULT_SCORE_SCALE): number | null {
  if (score === null || !Number.isFinite(score)) return null;
  const span = scale.p90 - scale.p10;
  if (!(span > 0)) return 0.5;
  return Math.min(1, Math.max(0, (score - scale.p10) / span));
}

/** The CSS color for a tone: the theme's (or the user's) loss color through to its win color. */
export function scoreToneColor(tone: number): string {
  return `color-mix(in oklab, var(--good-ink) ${Math.round(tone * 100)}%, var(--bad-ink))`;
}

/** The card tile's hover text: what the number is, in brief, with today's weights. */
export function scoreTooltip(
  score: number | null,
  w: ScoreWeightsInfo["weights"],
  scale?: ScoreWeightsInfo["scale"],
): string {
  const head =
    score === null
      ? "Composite score: not recorded for this alert."
      : `Composite score ${Math.round(score)}/100 at alert time.`;
  const base = `${head} How much the token looked like the launches that double fast: its last 5 minutes, its age and its holders. Weights adapt to recent winners: ${weightsLine(w)}.`;
  if (!scale) return `${base} Most fresh launches score 60-88.`;
  const from = scale.sample > 0 ? "the last day's alerts" : "typical fresh launches";
  return `${base} Color: red at or below ${Math.round(scale.p10)} (lowest 10% of ${from}), green at or above ${Math.round(scale.p90)} (top 10%).`;
}
