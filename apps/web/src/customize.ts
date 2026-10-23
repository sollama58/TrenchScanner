import { useSyncExternalStore } from "react";

/**
 * The one Customize window (components/CustomizeModal.tsx, user ask 2026-10-23): every option that
 * shapes the dashboard, in sections. Each Customize button on the page opens it at its own
 * section (the Live feed's at Cards or Scope, a Scope column's funnel at that column's filters,
 * the token window's at Token window, the chart's wallet-trades link at that part of Chart).
 * App mounts the window once; this is how the buttons reach it.
 */
export const CUSTOMIZE_SECTIONS = [
  "look",
  "cards",
  "card-fields",
  "scope",
  "scope-columns",
  "token",
  "chart",
  "bubbles",
  "trading",
  "app",
] as const;
export type CustomizeSection = (typeof CUSTOMIZE_SECTIONS)[number];

export interface CustomizeState {
  open: boolean;
  section: CustomizeSection;
  /** A Scope column whose filters to show (section "scope-columns"). */
  column: string | null;
  /** An element id inside the section to scroll to and light up (e.g. CHART_MARKS_SECTION). */
  anchor: string | null;
  /** Bumped on every opening, so opening the same section again still scrolls to it. */
  seq: number;
}

let state: CustomizeState = { open: false, section: "look", column: null, anchor: null, seq: 0 };
const listeners = new Set<() => void>();

function set(next: CustomizeState) {
  state = next;
  for (const l of listeners) l();
}

export function openCustomize(
  section: CustomizeSection = "look",
  opts: { column?: string | null; anchor?: string | null } = {},
): void {
  set({ open: true, section, column: opts.column ?? null, anchor: opts.anchor ?? null, seq: state.seq + 1 });
}

export function closeCustomize(): void {
  if (state.open) set({ ...state, open: false });
}

export function useCustomize(): CustomizeState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
