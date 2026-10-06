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

/** The card tile's hover text: what the number is, in brief, with today's weights. */
export function scoreTooltip(score: number | null, w: ScoreWeightsInfo["weights"]): string {
  const head =
    score === null
      ? "Composite score: not recorded for this alert."
      : `Composite score ${Math.round(score)}/100 at alert time.`;
  return `${head} How much the token looked like the launches that double fast: its last 5 minutes, its age and its holders. Weights adapt to recent winners: ${weightsLine(w)}. Most fresh launches score 60-88.`;
}
