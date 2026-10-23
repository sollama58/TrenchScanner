import { adapterForHost } from "./adapters/sites";
import { OverlayEngine } from "./engine";
import { DEFAULT_SETTINGS } from "../shared/settings";
import type { ContentRequest, LookupAnswer, OverlaySettings } from "../shared/types";

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
      });
      engine.start();
    } else if (!settings.sites[adapter.site] && engine) {
      engine.stop();
      engine = null;
    } else {
      engine?.applySettings(settings);
    }
  };
  sync();

  // The popup saved new settings: the worker broadcasts them to every tab it serves.
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    const m = message as { type?: string; settings?: OverlaySettings };
    if (m.type === "settingsChanged" && m.settings) {
      settings = m.settings;
      sync();
    }
  });
}

void main();
