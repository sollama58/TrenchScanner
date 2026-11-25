import { adapterForHost } from "./adapters/sites";
import { OverlayEngine } from "./engine";
import { HolderMarks } from "./holderMarks";
import { MapTab } from "./mapTab";
import { Toasts } from "./toasts";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { cleanTooltip, type TooltipPrefs } from "../shared/tooltip";
import type {
  ContentRequest,
  FeedAnswer,
  LookupAnswer,
  OverlayBubbleMap,
  OverlayBubbleTotals,
  OverlaySettings,
  SafetyAnswer,
  StatsAnswer,
} from "../shared/types";

/**
 * The content script, run in the extension's isolated world on Axiom, Terminal and GMGN only
 * (manifest.json). It holds no key and makes no network calls: it asks the service worker about
 * addresses and draws the answers. It never reads the site's storage, cookies or scripts.
 */
function ask<T>(request: ContentRequest): Promise<T | null> {
  if (!alive()) return Promise.resolve(null);
  return chrome.runtime.sendMessage(request).catch(() => {
    if (!alive()) retire();
    return null;
  }) as Promise<T | null>;
}

/**
 * The extension was updated, reloaded or removed while the tab stayed open: this script is cut off
 * from the worker (its runtime id is gone) but its observers and timers run on, and what it drew
 * stays. It takes all of it down, so a reloaded extension's fresh copy (once the tab reloads)
 * never draws beside a stale one.
 */
function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

const teardown: (() => void)[] = [];
let retired = false;
function retire(): void {
  if (retired) return;
  retired = true;
  for (const stop of teardown.splice(0)) {
    try {
      stop();
    } catch {
      // One part failing to stop must not leave the others running.
    }
  }
}

/** How often a script checks it is still the extension's (see alive). */
const ORPHAN_CHECK_MS = 10_000;

async function main(): Promise<void> {
  const adapter = adapterForHost(location.hostname);
  if (!adapter) return;
  let settings = (await ask<OverlaySettings>({ type: "settings" })) ?? DEFAULT_SETTINGS;
  let tooltip = cleanTooltip(await ask<TooltipPrefs>({ type: "tooltip" }));
  let engine: OverlayEngine | null = null;

  const sync = () => {
    if (settings.sites[adapter.site] && !engine) {
      engine = new OverlayEngine(adapter, settings, {
        lookup: async (mints) =>
          (await ask<LookupAnswer>({ type: "lookup", mints })) ?? { tokens: {}, problem: "offline" },
        totals: async (mint) => await ask<OverlayBubbleTotals>({ type: "totals", mint }),
        safety: async (mints) =>
          (await ask<SafetyAnswer>({ type: "safety", mints })) ?? { verdicts: {}, problem: "offline" },
        stats: async (mints) =>
          (await ask<StatsAnswer>({ type: "stats", mints })) ?? { tokens: {}, problem: "offline" },
        snooze: (mint, minutes) => void ask({ type: "snooze", mint, minutes }),
        openCoin: (mint) => void ask({ type: "openCoin", mint }),
      });
      engine.applyTooltip(tooltip);
      engine.start();
    } else if (!settings.sites[adapter.site] && engine) {
      engine.stop();
      engine = null;
    } else {
      engine?.applySettings(settings);
    }
  };
  sync();

  const mapTab = new MapTab(adapter.site, tooltip);
  mapTab.start();
  const holderMarks = new HolderMarks(adapter.site, tooltip, {
    holders: (mint) => ask<OverlayBubbleMap>({ type: "holders", mint }),
    openMap: () => mapTab.show(),
  });
  holderMarks.start();
  const toasts = new Toasts(
    adapter.site,
    {
      alerts: () => ask<FeedAnswer>({ type: "alerts" }),
      totals: (mint) => ask<OverlayBubbleTotals>({ type: "totals", mint }),
    },
    tooltip,
    settings,
  );
  toasts.start();

  teardown.push(
    () => engine?.stop(),
    () => mapTab.stop(),
    () => holderMarks.stop(),
    () => toasts.stop(),
  );
  const watchdog = window.setInterval(() => {
    if (!alive()) retire();
  }, ORPHAN_CHECK_MS);
  teardown.push(() => window.clearInterval(watchdog));

  // The popup saved new settings: the worker broadcasts them to every tab it serves.
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    const m = message as {
      type?: string;
      settings?: OverlaySettings;
      prefs?: unknown;
      tokens?: StatsAnswer["tokens"];
    };
    // Live board pills (user ask 2026-10-27): new numbers the worker was told of, pushed to the tab.
    if (m.type === "boardStats" && m.tokens && typeof m.tokens === "object") {
      engine?.receiveStats(Object.keys(m.tokens), { tokens: m.tokens, problem: null });
    }
    if (m.type === "settingsChanged" && m.settings) {
      settings = m.settings;
      sync();
      toasts.apply(tooltip, settings);
    }
    if (m.type === "tooltipChanged") {
      tooltip = cleanTooltip(m.prefs);
      engine?.applyTooltip(tooltip);
      mapTab.applyPrefs(tooltip);
      holderMarks.applyPrefs(tooltip);
      toasts.apply(tooltip, settings);
    }
  });
}

void main();
