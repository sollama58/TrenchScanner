import { useSyncExternalStore } from "react";
import { put } from "./api";
import { isGuest } from "./session";

/**
 * One section of the account's synced preferences (GET /settings `prefs`, PUT
 * /settings/prefs/:section; apps/api/src/userPrefs.ts): the Pro trade defaults and the layout
 * choices that used to stay in one browser. Each is kept in localStorage too, so this device shows
 * it at once and keeps it if a save fails, and saved to the account a moment after it settles.
 *
 * Saving only starts once a settings load for a signed-in account has landed (adopt): a guest's
 * choices, or ones made before that load, stay on this device until then. An account with nothing
 * saved yet takes this browser's choice, if it differs from the defaults (as Scope's do). On a
 * sign-out the device copy is dropped (reset), so the next account to sign in here doesn't take it.
 */
export interface SyncedSection<T> {
  get(): T;
  set(next: T): void;
  use(): T;
  /** Whether changes here go to the account (a signed-in settings load has landed). */
  synced(): boolean;
  version(): number;
  adopt(saved: unknown, sinceVersion: number): void;
  reset(): void;
}

const SAVE_DELAY_MS = 600;

export function syncedSection<T>({
  section,
  storageKey,
  defaults,
  parse,
}: {
  section: string;
  storageKey: string;
  defaults: T;
  /** The section from storage or the account; anything unreadable falls back to the defaults. */
  parse: (raw: unknown) => T;
}): SyncedSection<T> {
  const read = (): T => {
    try {
      const text = localStorage.getItem(storageKey);
      return text ? parse(JSON.parse(text)) : defaults;
    } catch {
      return defaults;
    }
  };
  const write = (v: T) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(v));
    } catch {
      // Storage blocked or full: the account copy still has it.
    }
  };
  const same = (a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

  let current: T | null = null;
  let bound = false;
  /** Changed while signed in but before the account's copy loaded: it goes to the account. */
  let pendingLocal = false;
  let version = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight = 0;
  const listeners = new Set<() => void>();
  const get = () => (current ??= read());
  const emit = () => {
    for (const l of listeners) l();
  };

  const save = async () => {
    const sending = get();
    inflight++;
    try {
      await put(`/settings/prefs/${section}`, sending);
    } catch {
      // Kept on this device; the next change tries the account again.
    } finally {
      inflight--;
    }
  };
  const schedule = () => {
    if (!bound) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void save();
    }, SAVE_DELAY_MS);
  };

  if (typeof window !== "undefined") {
    // Another tab of this browser changed it: show the same here. That tab saves it.
    window.addEventListener("storage", (e) => {
      if (e.key !== storageKey) return;
      const next = read();
      if (same(next, get())) return;
      current = next;
      emit();
    });
  }

  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };

  return {
    get,
    set(next) {
      current = next;
      version++;
      write(next);
      emit();
      if (!bound && !isGuest()) pendingLocal = true;
      schedule();
    },
    use() {
      return useSyncExternalStore(subscribe, get, () => defaults);
    },
    synced: () => bound,
    version: () => version,
    adopt(saved, sinceVersion) {
      // An API build without synced prefs sends nothing: stay on this device.
      if (saved === undefined) return;
      bound = true;
      const local = pendingLocal;
      pendingLocal = false;
      if (saved === null) {
        if (!same(get(), defaults)) schedule();
        return;
      }
      // Changed here since the load went out, or still saving: this device's is the newer.
      if (local || version !== sinceVersion || timer !== null || inflight > 0) {
        if (timer === null && inflight === 0) schedule();
        return;
      }
      const next = parse(saved);
      if (same(next, get())) return;
      current = next;
      write(next);
      emit();
    },
    reset() {
      if (timer) clearTimeout(timer);
      timer = null;
      bound = false;
      pendingLocal = false;
      version++;
      current = defaults;
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // Storage blocked: nothing was kept there either.
      }
      emit();
    },
  };
}
