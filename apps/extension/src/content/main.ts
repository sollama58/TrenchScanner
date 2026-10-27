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
  return chrome.runtime.sendMessage(request).catch(() => null) as Promise<T | null>;
}

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
        report: (health) =>
          void chrome.runtime
            .sendMessage({ type: "health", site: adapter.site, ...health })
            .catch(() => undefined),
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
