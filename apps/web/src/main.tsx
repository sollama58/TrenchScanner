import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { UpdateBanner } from "./components/UpdateBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  loadAdminTab,
  loadFiltersTab,
  loadLighthouseTab,
  loadModelTab,
  loadSettingsTab,
  loadSignIn,
  tabFromHash,
} from "./routes";
import { startVersionWatch } from "./version";
import { installTouchTips } from "./touchTips";
import { captureInstallPrompt } from "./installApp";
import "./fonts.css";
import "./styles.css";

// Before anything lazy loads: a chunk removed by a deploy since this page loaded reloads the tab.
startVersionWatch();
// Phones and tablets: a tap shows what a desktop shows on hover.
installTouchTips();
// Chrome offers its install dialog once, early: hold it for the "Install the app" buttons.
captureInstallPrompt();

// index.html has already started this screen's API calls (window.__boot); start its code too.
const tab = tabFromHash();
if (tab === "model") void loadModelTab();
else if (tab === "lighthouse") void loadLighthouseTab();
else if (tab === "filters") void loadFiltersTab();
else if (tab === "settings") void loadSettingsTab();
else if (tab === "admin") void loadAdminTab();
// A signed-out visitor needs the sign-in code next; fetch it as soon as the session check says so.
void window.__boot?.["/auth/me"]?.then(
  (res) => {
    if (!res.ok) void loadSignIn();
  },
  () => void loadSignIn(),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <UpdateBanner />
  </StrictMode>,
);

// Once the first screen is up, fetch the other tabs' code in the background so switching is instant.
const warm = () => {
  void loadModelTab();
  void loadLighthouseTab();
  void loadFiltersTab();
  void loadSettingsTab();
  void loadSignIn();
};
if ("requestIdleCallback" in window) window.requestIdleCallback(warm, { timeout: 4000 });
else setTimeout(warm, 2000);
