import { useSyncExternalStore } from "react";
import type { NarrativeNoteReadiness } from "./api";
import { cachedGet, peek } from "./cache";
import { useAppearance } from "./appearance";

/**
 * Whether the Narrative model's "agrees" / "warns" pill shows on other models' cards. The reader's
 * Customize toggle (FeedAppearance.narrativeNote) when they set it; otherwise the automatic
 * default from GET /config/narrative-note, which turns on once the 90% interval on the Narrative
 * model's 7-day 2x hit rate clears 40%, and off only once it falls wholly below 40%; in between it
 * holds (packages/core/src/curation/narrativeNote.ts). The band lives on the server, so this just
 * reads `ready`. Fetched once per page and re-read now and then, like the score weights.
 */
const REFRESH_MS = 10 * 60_000;

const PATH = "/config/narrative-note";
// The last visit's answer (src/cache.ts keeps it): the pill is on the first cards painted, not
// added a moment later, which moved every card's lower half.
let current: NarrativeNoteReadiness | null = peek<NarrativeNoteReadiness>(PATH)?.data ?? null;
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): void {
  if (inFlight || Date.now() - fetchedAt < REFRESH_MS) return;
  // Through the cache: index.html starts this read before the app has loaded, and this adopts it.
  inFlight = cachedGet<NarrativeNoteReadiness>(PATH)
    .then((info) => {
      current = info;
      fetchedAt = Date.now();
      listeners.forEach((l) => l());
    })
    .catch(() => {
      // Keep what we have (off until read); try again a minute later.
      fetchedAt = Date.now() - REFRESH_MS + 60_000;
    })
    .finally(() => {
      inFlight = null;
    });
}

/** The automatic default's state; null until the first read lands. */
export function useNarrativeNoteReadiness(): NarrativeNoteReadiness | null {
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

/** Whether cards show the Narrative pill for this reader right now. */
export function useShowNarrativeNote(): boolean {
  const { narrativeNote } = useAppearance();
  const readiness = useNarrativeNoteReadiness();
  return narrativeNote ?? readiness?.ready ?? false;
}
