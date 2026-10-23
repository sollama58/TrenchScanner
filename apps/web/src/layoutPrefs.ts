import { useSyncExternalStore } from "react";
import { syncedSection } from "./syncedPrefs";

/**
 * Layout choices that follow the account (apps/api/src/userPrefs.ts `layout`): whether the Live
 * feed opens on Cards or Scope, and what sits beside the Pro token chart. Both used to stay in one
 * browser; a browser that chose them before keeps its choice and hands it to the account.
 */
export const TOKEN_SIDE_VIEWS = [
  "none",
  "map",
  "trades",
  "holders",
  "wallets",
  "flow",
  "dev",
  "sage",
] as const;
export type TokenSide = (typeof TOKEN_SIDE_VIEWS)[number];
/** As the token window's own picker names them. */
export const TOKEN_SIDE_LABELS: Record<TokenSide, string> = {
  none: "None: the chart takes the row",
  map: "Bubble map",
  trades: "Live trades",
  holders: "Holders",
  wallets: "Labeled wallets",
  flow: "Order flow",
  dev: "Dev & socials",
  sage: "TokenSage",
};

export type LiveView = "cards" | "scope";

export interface LayoutPrefs {
  liveView: LiveView;
  tokenSide: TokenSide;
}

export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = { liveView: "cards", tokenSide: "map" };

/** Where these lived before they synced (LiveTab, TokenModal). */
const OLD_LIVE_VIEW_KEY = "ts-live-view";
const OLD_TOKEN_SIDE_KEY = "ts-scope-side";
const LAYOUT_KEY = "ts-layout-prefs";

export function parseLayoutPrefs(raw: unknown): LayoutPrefs {
  const v = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
    Record<keyof LayoutPrefs, unknown>
  >;
  return {
    liveView: v.liveView === "scope" ? "scope" : "cards",
    tokenSide: TOKEN_SIDE_VIEWS.includes(v.tokenSide as TokenSide)
      ? (v.tokenSide as TokenSide)
      : DEFAULT_LAYOUT_PREFS.tokenSide,
  };
}

/** The old per-browser keys, moved under the synced one once. */
function migrateOldKeys(): void {
  try {
    if (localStorage.getItem(LAYOUT_KEY) !== null) return;
    const view = localStorage.getItem(OLD_LIVE_VIEW_KEY);
    const side = localStorage.getItem(OLD_TOKEN_SIDE_KEY);
    if (view === null && side === null) return;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(parseLayoutPrefs({ liveView: view, tokenSide: side })));
    localStorage.removeItem(OLD_LIVE_VIEW_KEY);
    localStorage.removeItem(OLD_TOKEN_SIDE_KEY);
  } catch {
    // Storage blocked: the defaults, and the account's once it loads.
  }
}
if (typeof window !== "undefined") migrateOldKeys();

export const layoutPrefsSync = syncedSection<LayoutPrefs>({
  section: "layout",
  storageKey: LAYOUT_KEY,
  defaults: DEFAULT_LAYOUT_PREFS,
  parse: parseLayoutPrefs,
});

export const useLayoutPrefs = (): LayoutPrefs => layoutPrefsSync.use();

export function setLayoutPrefs(change: Partial<LayoutPrefs>): void {
  layoutPrefsSync.set({ ...layoutPrefsSync.get(), ...change });
}

// ---- This device only ----

/**
 * Whether the market bar starts open (user ask 2026-10-23: collapsed until opened). Per device, as
 * a phone and a wide screen want different things; Customize and the bar's own toggle share it.
 */
const MARKET_BAR_OPEN_KEY = "ts-market-bar-open";
let marketBarOpen: boolean | null = null;
const barListeners = new Set<() => void>();

function readMarketBarOpen(): boolean {
  try {
    return localStorage.getItem(MARKET_BAR_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMarketBarOpen(open: boolean): void {
  marketBarOpen = open;
  try {
    localStorage.setItem(MARKET_BAR_OPEN_KEY, open ? "1" : "0");
  } catch {
    // A private window: the choice lasts this visit.
  }
  for (const l of barListeners) l();
}

export function useMarketBarOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      barListeners.add(l);
      return () => barListeners.delete(l);
    },
    () => (marketBarOpen ??= readMarketBarOpen()),
    () => false,
  );
}
