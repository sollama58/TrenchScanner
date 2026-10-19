import { lazy, useState } from "react";

/**
 * The Live tab's windows and its Scope view, split out of the first screen's code: each one shows
 * only after a click (or, for Scope and the first-visit tour, on a view most visits don't open
 * on). main.tsx warms the ones a click opens once the first screen is idle, so a click usually
 * finds its code already here.
 */
export const loadAboutModal = () => import("./components/AboutModal");
export const loadFeedStatsModal = () => import("./components/FeedStatsModal");
export const loadCustomizeDrawer = () => import("./components/CustomizeDrawer");
export const loadSearchModal = () => import("./components/CaSearch");
export const loadScopeBoard = () => import("./components/ScopeBoard");

export const AboutModal = lazy(() => loadAboutModal().then((m) => ({ default: m.AboutModal })));
export const FeedStatsModal = lazy(() => loadFeedStatsModal().then((m) => ({ default: m.FeedStatsModal })));
export const CustomizeDrawer = lazy(() =>
  loadCustomizeDrawer().then((m) => ({ default: m.CustomizeDrawer })),
);
export const SearchModal = lazy(() => loadSearchModal().then((m) => ({ default: m.SearchModal })));
export const ScopeBoard = lazy(() => loadScopeBoard().then((m) => ({ default: m.ScopeBoard })));

/** Warms the code behind the Live tab's buttons (main.tsx, once the first screen is idle). */
export function warmLivePanels() {
  void loadFeedStatsModal();
  void loadCustomizeDrawer();
  void loadSearchModal();
  void loadScopeBoard();
}

/**
 * True from the first time `open` is, and from then on: a lazy window mounts on its first opening
 * and then stays mounted, so closing and reopening it works exactly as before it was split out
 * (its native dialog closes itself, focus goes back, its state is kept).
 */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}
