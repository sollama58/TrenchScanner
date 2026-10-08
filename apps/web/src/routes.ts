/** The dashboard's tabs, and the code-split chunks behind them. */
export type Tab = "live" | "model" | "lighthouse" | "filters" | "settings" | "admin";

export function tabFromHash(): Tab {
  const h = window.location.hash.replace("#", "");
  // Top filters used to be its own tab; it is a card on the Filters tab now, so old links land there.
  if (h === "top") return "filters";
  return h === "model" || h === "lighthouse" || h === "filters" || h === "settings" || h === "admin"
    ? h
    : "live";
}

type ModelTabModule = typeof import("./tabs/ModelTab");
type LighthouseTabModule = typeof import("./tabs/LighthouseTab");
type FiltersTabModule = typeof import("./tabs/FiltersTab");
type SettingsTabModule = typeof import("./tabs/SettingsTab");
type AdminTabModule = typeof import("./tabs/AdminTab");

/**
 * Chunks already downloaded. React.lazy suspends on its first render even when the chunk is in
 * the browser, which flashed the loading logo on every first open of a warmed tab; App renders
 * these directly instead once they are here.
 */
export const loaded: {
  model?: ModelTabModule;
  lighthouse?: LighthouseTabModule;
  filters?: FiltersTabModule;
  settings?: SettingsTabModule;
  admin?: AdminTabModule;
} = {};

export const loadModelTab = () => import("./tabs/ModelTab").then((m) => (loaded.model = m));
export const loadLighthouseTab = () => import("./tabs/LighthouseTab").then((m) => (loaded.lighthouse = m));
export const loadFiltersTab = () => import("./tabs/FiltersTab").then((m) => (loaded.filters = m));
export const loadSettingsTab = () => import("./tabs/SettingsTab").then((m) => (loaded.settings = m));
export const loadAdminTab = () => import("./tabs/AdminTab").then((m) => (loaded.admin = m));
export const loadSignIn = () => import("./components/SignIn");

/** The browser's IANA zone, for the Lighthouse's hour-of-day chart; empty when it can't say (the API reads UTC). */
function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/**
 * The Lighthouse's path for a window (`base` is /curated or /guest). Built here, in the main
 * bundle, so the warm-up below asks for exactly what the tab's Right now will (index.html builds
 * the same path for the boot prefetch).
 */
export const lighthousePath = (base: string, days: number) => {
  const tz = browserTimeZone();
  return `${base}/lighthouse?days=${days}${tz ? `&tz=${encodeURIComponent(tz)}` : ""}`;
};

/**
 * The GETs each tab makes on mount (index.html keeps its own copy for the boot prefetch). Warming
 * these in the background lets a tab paint its data the moment it opens, then refresh.
 */
export const TAB_DATA: Record<Tab, string[]> = {
  live: [
    "/matches?page=1&includeCurated=saved",
    "/matches/stats?hours=24",
    "/curated/stats",
    "/curated/models?days=30",
  ],
  model: ["/curated/insights?days=7", "/curated/models?days=7"],
  lighthouse: [
    "/curated/lighthouse/history?days=30&bucket=day&dimension=category",
    lighthousePath("/curated", 7),
  ],
  filters: [
    "/filters",
    "/config",
    "/filters/leaderboard",
    "/settings",
    "/curated/models?days=30",
    "/telegram",
  ],
  settings: ["/settings"],
  // Nothing warmed: only admin wallets can read /admin, and everyone's session runs this warm-up.
  admin: [],
};
