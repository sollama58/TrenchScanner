/**
 * What the page is waiting on, for the loading bar (components/PageLoader.tsx).
 *
 * A "wait" is anything the screen can't show yet: a view whose first answer (or whose answer for a
 * new path) hasn't landed, or a tab's code still downloading. Waits that overlap, or follow one
 * another within SETTLE_MS, make one load; its progress is how many of the waits it has seen so
 * far have finished. A load that starts just after a navigation (a tab switch, signing in, the
 * page opening) is a page load and gets the full overlay; any other (a window switch inside a tab)
 * only gets the thin bar.
 */

export interface LoadState {
  /** A load is under way (waits pending, or finished less than SETTLE_MS ago). */
  active: boolean;
  /** Waits this load has seen, and how many of them have finished. */
  total: number;
  done: number;
  /** The load followed a navigation, so the page behind it is not this page yet. */
  page: boolean;
  /** When the load started (performance.now()). */
  startedAt: number;
  /** The page's first load, which follows index.html's own loader straight on. */
  boot: boolean;
}

/** A wait starting this soon after the last one finished continues the same load. */
const SETTLE_MS = 150;
/** A load starting this soon after a navigation is that page's load. */
const NAV_WINDOW_MS = 600;

const pending = new Set<symbol>();
const listeners = new Set<() => void>();
let state: LoadState = { active: false, total: 0, done: 0, page: false, startedAt: 0, boot: false };
let navAt = Number.NEGATIVE_INFINITY;
/** The page opening counts as a navigation. */
let first = true;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

function set(next: Partial<LoadState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Registers something the screen is waiting on; call the returned function once it is done. */
export function beginWait(): () => void {
  const id = Symbol();
  clearTimeout(settleTimer);
  settleTimer = undefined;
  if (!state.active) {
    const now = performance.now();
    set({
      active: true,
      total: 0,
      done: 0,
      startedAt: now,
      page: first || now - navAt < NAV_WINDOW_MS,
      boot: first,
    });
    first = false;
  }
  pending.add(id);
  set({ total: state.total + 1 });
  return () => {
    if (!pending.delete(id)) return;
    set({ done: state.done + 1 });
    if (pending.size === 0) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        if (pending.size === 0) set({ active: false });
      }, SETTLE_MS);
    }
  };
}

/** The user went somewhere new: what loads next (or is loading now) is that page's load. */
export function markNavigation(): void {
  navAt = performance.now();
  if (state.active && !state.page) set({ page: true });
}

export function loadState(): LoadState {
  return state;
}

export function subscribeLoad(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests: forget everything. */
export function resetLoadTracker(): void {
  pending.clear();
  clearTimeout(settleTimer);
  settleTimer = undefined;
  navAt = Number.NEGATIVE_INFINITY;
  first = true;
  state = { active: false, total: 0, done: 0, page: false, startedAt: 0, boot: false };
}
