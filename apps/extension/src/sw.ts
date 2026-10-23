import { api, ApiError } from "./shared/api";
import { DEFAULT_SETTINGS } from "./shared/settings";
import type {
  FeedAnswer,
  OverlaySettings,
  OverlayToken,
  PanelRequest,
  Problem,
  Status,
} from "./shared/types";

/**
 * The service worker: the only part that holds the key or touches the network, and only
 * api.trenchscanner.app. Only the extension's own side panel is answered.
 *
 * The extension has no access to Axiom, Terminal, GMGN or any other site: no content scripts, no
 * host permissions beyond the API, no tabs, scripting or cookies. It never runs inside a trading
 * site, so nothing it ships (or a bad update of it) can read a site's page or login. The panel
 * lists the reader's alerts and opens a token on a site as an ordinary link.
 */

const KEY_SHAPE = /^tsx_[A-Za-z0-9_-]{43}$/;
/** The account's settings are re-read this often, so a change from another browser arrives. */
const SETTINGS_REFRESH_MS = 5 * 60_000;

interface Stored {
  key?: string;
  wallet?: string;
  settings?: OverlaySettings;
}

let problem: Problem = null;
let settingsReadAt = 0;
let lastTokens: OverlayToken[] = [];

// The toolbar icon (and its shortcut) opens the panel beside the page.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

async function stored(): Promise<Stored> {
  return (await chrome.storage.local.get(["key", "wallet", "settings"])) as Stored;
}

async function currentSettings(): Promise<OverlaySettings> {
  const { key, settings } = await stored();
  if (key && Date.now() - settingsReadAt >= SETTINGS_REFRESH_MS) {
    settingsReadAt = Date.now();
    void api
      .me(key)
      .then((me) => chrome.storage.local.set({ wallet: me.wallet, settings: me.settings }))
      .catch((e: unknown) => noteFailure(e));
  }
  return settings ?? DEFAULT_SETTINGS;
}

function noteFailure(e: unknown): void {
  problem = e instanceof ApiError && (e.status === 401 || e.status === 403) ? "refused" : "offline";
}

async function feed(): Promise<FeedAnswer> {
  const { key } = await stored();
  if (!key) return { tokens: [], problem: "disconnected" };
  try {
    lastTokens = (await api.feed(key)).tokens;
    problem = null;
  } catch (e) {
    noteFailure(e);
  }
  return { tokens: lastTokens, problem };
}

async function status(): Promise<Status> {
  const { key, wallet } = await stored();
  return {
    connected: Boolean(key),
    wallet: wallet ?? null,
    settings: await currentSettings(),
    problem: key ? problem : "disconnected",
  };
}

async function handle(request: PanelRequest): Promise<unknown> {
  switch (request.type) {
    case "status":
      return status();
    case "feed":
      return feed();
    case "connect": {
      const key = typeof request.key === "string" ? request.key.trim() : "";
      if (!KEY_SHAPE.test(key))
        return { ok: false, error: "That doesn't look like an extension key. It starts with tsx_." };
      try {
        const me = await api.me(key);
        await chrome.storage.local.set({ key, wallet: me.wallet, settings: me.settings });
        settingsReadAt = Date.now();
        problem = null;
        lastTokens = [];
        return { ok: true };
      } catch (e) {
        if (e instanceof ApiError && e.status === 403)
          return { ok: false, error: "This account needs a paid subscription to use the extension." };
        if (e instanceof ApiError && e.status === 401)
          return { ok: false, error: "That key isn't valid. It may have been revoked in Settings." };
        return { ok: false, error: "Couldn't reach TrenchScanner. Check your connection and try again." };
      }
    }
    case "disconnect":
      await chrome.storage.local.remove(["key", "wallet"]);
      lastTokens = [];
      problem = "disconnected";
      return { ok: true };
    case "saveSettings": {
      const { key } = await stored();
      await chrome.storage.local.set({ settings: request.settings });
      if (key) await api.saveSettings(key, request.settings).catch((e: unknown) => noteFailure(e));
      return { ok: true };
    }
    default:
      return null;
  }
}

/** The extension's own pages: the side panel, or the panel opened in a tab. */
function fromPanel(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !fromPanel(sender)) return false;
  if (typeof message !== "object" || message === null) return false;
  handle(message as PanelRequest).then(sendResponse, () => sendResponse(null));
  return true;
});
