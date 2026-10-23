import { api, ApiError } from "./shared/api";
import { chunk, LOOKUP_CHUNK, LookupCache } from "./shared/lookupCache";
import { isMintAddress } from "./shared/mint";
import { DEFAULT_SETTINGS } from "./shared/settings";
import {
  SITES,
  type ContentRequest,
  type LookupAnswer,
  type OverlaySettings,
  type PopupRequest,
  type Site,
  type Status,
} from "./shared/types";

/**
 * The service worker: the only part that holds the key or touches the network, and only
 * api.trenchscanner.app. Content scripts may ask it to look up addresses and read settings;
 * the popup may connect, disconnect and save settings. Nothing else is answered.
 */

const KEY_SHAPE = /^tsx_[A-Za-z0-9_-]{43}$/;
const SITE_HOSTS: Record<Site, RegExp> = {
  axiom: /(^|\.)axiom\.trade$/,
  terminal: /(^|\.)padre\.gg$/,
  gmgn: /(^|\.)gmgn\.ai$/,
};
/** The account's settings are re-read this often, so a change from another browser arrives. */
const SETTINGS_REFRESH_MS = 5 * 60_000;

interface Stored {
  key?: string;
  wallet?: string;
  settings?: OverlaySettings;
}

const cache = new LookupCache();
const inFlight = new Map<string, Promise<void>>();
const health = new Map<number, { site: Site; rows: number; mints: number; paused: boolean }>();
let problem: LookupAnswer["problem"] = null;
let settingsReadAt = 0;

async function stored(): Promise<Stored> {
  return (await chrome.storage.local.get(["key", "wallet", "settings"])) as Stored;
}

async function currentSettings(): Promise<OverlaySettings> {
  const { key, settings } = await stored();
  if (key && Date.now() - settingsReadAt >= SETTINGS_REFRESH_MS) {
    settingsReadAt = Date.now();
    void api
      .me(key)
      .then(async (me) => {
        await chrome.storage.local.set({ wallet: me.wallet, settings: me.settings });
        broadcast(me.settings);
      })
      .catch((e: unknown) => noteFailure(e));
  }
  return settings ?? DEFAULT_SETTINGS;
}

function noteFailure(e: unknown): void {
  problem = e instanceof ApiError && (e.status === 401 || e.status === 403) ? "refused" : "offline";
}

function broadcast(settings: OverlaySettings): void {
  for (const tabId of health.keys()) {
    chrome.tabs.sendMessage(tabId, { type: "settingsChanged", settings }).catch(() => health.delete(tabId));
  }
}

async function lookup(mints: string[]): Promise<LookupAnswer> {
  const { key } = await stored();
  if (!key) return { tokens: {}, problem: "disconnected" };
  const now = Date.now();
  const waits: Promise<void>[] = [];
  const fresh: string[] = [];
  for (const mint of cache.missing(mints, now)) {
    const pending = inFlight.get(mint);
    if (pending) waits.push(pending);
    else fresh.push(mint);
  }
  for (const part of chunk(fresh, LOOKUP_CHUNK)) {
    const request = api.lookup(key, part).then(
      (result) => {
        problem = null;
        cache.store(part, result.tokens, Date.now());
      },
      (e: unknown) => noteFailure(e),
    );
    const settled = request.finally(() => part.forEach((m) => inFlight.delete(m)));
    for (const mint of part) inFlight.set(mint, settled);
    waits.push(settled);
  }
  await Promise.all(waits);
  return { tokens: cache.answer(mints), problem };
}

function fromSite(sender: chrome.runtime.MessageSender): Site | null {
  if (!sender.tab || !sender.url) return null;
  let host: string;
  try {
    const url = new URL(sender.url);
    if (url.protocol !== "https:") return null;
    host = url.hostname;
  } catch {
    return null;
  }
  return SITES.find((site) => SITE_HOSTS[site].test(host)) ?? null;
}

/** The extension's own pages (the popup, or the popup opened in a tab). Content scripts carry the site's URL. */
function fromPopup(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

async function handleContent(request: ContentRequest, tabId: number): Promise<unknown> {
  switch (request.type) {
    case "lookup": {
      if (!Array.isArray(request.mints)) return null;
      const mints = request.mints
        .filter((m): m is string => typeof m === "string" && isMintAddress(m))
        .slice(0, LOOKUP_CHUNK);
      return lookup(mints);
    }
    case "settings":
      return currentSettings();
    case "health":
      if (SITES.includes(request.site)) {
        health.set(tabId, {
          site: request.site,
          rows: Number(request.rows) || 0,
          mints: Number(request.mints) || 0,
          paused: request.paused === true,
        });
      }
      return null;
    default:
      return null;
  }
}

async function status(): Promise<Status> {
  const { key, wallet } = await stored();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  return {
    connected: Boolean(key),
    wallet: wallet ?? null,
    settings: await currentSettings(),
    problem: key ? problem : "disconnected",
    page: tab?.id === undefined ? null : (health.get(tab.id) ?? null),
  };
}

async function handlePopup(request: PopupRequest): Promise<unknown> {
  switch (request.type) {
    case "status":
      return status();
    case "connect": {
      const key = typeof request.key === "string" ? request.key.trim() : "";
      if (!KEY_SHAPE.test(key))
        return { ok: false, error: "That doesn't look like an extension key. It starts with tsx_." };
      try {
        const me = await api.me(key);
        await chrome.storage.local.set({ key, wallet: me.wallet, settings: me.settings });
        settingsReadAt = Date.now();
        problem = null;
        cache.clear();
        broadcast(me.settings);
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
      cache.clear();
      problem = "disconnected";
      broadcast(await currentSettings());
      return { ok: true };
    case "saveSettings": {
      const { key } = await stored();
      await chrome.storage.local.set({ settings: request.settings });
      broadcast(request.settings);
      if (key) await api.saveSettings(key, request.settings).catch((e: unknown) => noteFailure(e));
      return { ok: true };
    }
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof message !== "object" || message === null) return false;
  const site = fromSite(sender);
  const work =
    site !== null && sender.tab?.id !== undefined
      ? handleContent(message as ContentRequest, sender.tab.id)
      : fromPopup(sender)
        ? handlePopup(message as PopupRequest)
        : null;
  if (!work) return false;
  work.then(sendResponse, () => sendResponse(null));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => health.delete(tabId));
