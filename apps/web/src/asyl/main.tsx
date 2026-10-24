import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startVersionWatch } from "../version";
import { AsylApp } from "./AsylApp";
import { SharedView } from "./SharedView";
import { parseRoute } from "./route";
import { paintWalls } from "./scrawl";
import "@fontsource/permanent-marker/400.css";
import "../fonts.css";
import "../styles.css";
import "./asyl.css";

// One look, dark: the dashboard's light theme never applies here.
document.documentElement.setAttribute("data-theme", "dark");
paintWalls();
startVersionWatch();

const route = parseRoute(location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>{route.kind === "shared" ? <SharedView slug={route.slug} /> : <AsylApp />}</StrictMode>,
);
