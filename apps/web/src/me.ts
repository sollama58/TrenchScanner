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
  );
}
