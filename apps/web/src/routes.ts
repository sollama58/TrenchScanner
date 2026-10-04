/** The dashboard's tabs, and the code-split chunks behind them. */
export type Tab = "live" | "model" | "filters";

export function tabFromHash(): Tab {
  const h = window.location.hash.replace("#", "");
  return h === "model" || h === "filters" ? h : "live";
}

type ModelTabModule = typeof import("./tabs/ModelTab");
type FiltersTabModule = typeof import("./tabs/FiltersTab");

/**
 * Chunks already downloaded. React.lazy suspends on its first render even when the chunk is in
 * the browser, which flashed the loading logo on every first open of a warmed tab; App renders
 * these directly instead once they are here.
 */
export const loaded: { model?: ModelTabModule; filters?: FiltersTabModule } = {};

export const loadModelTab = () => import("./tabs/ModelTab").then((m) => (loaded.model = m));
export const loadFiltersTab = () => import("./tabs/FiltersTab").then((m) => (loaded.filters = m));
export const loadSignIn = () => import("./components/SignIn");

/**
 * The GETs each tab makes on mount (index.html keeps its own copy for the boot prefetch). Warming
 * these in the background lets a tab paint its data the moment it opens, then refresh.
 */
export const TAB_DATA: Record<Tab, string[]> = {
  live: ["/matches?page=1&includeCurated=saved", "/curated/stats", "/curated/models?days=30"],
  model: ["/curated/insights?days=30", "/curated/models?days=30"],
  filters: ["/filters", "/config"],
};
