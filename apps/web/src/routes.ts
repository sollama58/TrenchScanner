/** The dashboard's tabs, and the code-split chunks behind them. */
export type Tab = "live" | "model" | "filters";

export function tabFromHash(): Tab {
  const h = window.location.hash.replace("#", "");
  return h === "model" || h === "filters" ? h : "live";
}

export const loadModelTab = () => import("./tabs/ModelTab");
export const loadFiltersTab = () => import("./tabs/FiltersTab");
export const loadSignIn = () => import("./components/SignIn");
