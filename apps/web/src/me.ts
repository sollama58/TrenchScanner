import { useSyncExternalStore } from "react";
import type { User } from "./api";

/** The signed-in user, as App last read it, for panels deep in a tab (null signed out). */
let me: User | null = null;
const listeners = new Set<() => void>();

export function setMe(user: User | null): void {
  if (user === me) return;
  me = user;
  for (const l of listeners) l();
}

export function currentMe(): User | null {
  return me;
}

export function useMe(): User | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => me,
    () => me,
  );
}

const RECHECK_EVENT = "ts:recheck-me";

/**
 * Asks App to read the session again now, rather than at its next two-minute re-read: Settings'
 * Pro Mode card calls it once a qualifying wallet's hour is up, so Pro Mode shows at the scan
 * that switches it on.
 */
export function recheckMe(): void {
  window.dispatchEvent(new Event(RECHECK_EVENT));
}

export function onRecheckMe(fn: () => void): () => void {
  window.addEventListener(RECHECK_EVENT, fn);
  return () => window.removeEventListener(RECHECK_EVENT, fn);
}
