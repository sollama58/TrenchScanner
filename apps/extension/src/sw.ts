import { api, ApiError } from "./shared/api";
import { isMintAddress } from "./shared/mint";
import { DEFAULT_SETTINGS } from "./shared/settings";
import { cleanTooltip, type TooltipPrefs } from "./shared/tooltip";
import type {
  ContentRequest,
  LookupAnswer,
  BubbleAnswer,
  BuddyAnswer,
  BuddyRead,
  FeedAnswer,
  OverlaySettings,
  OverlayToken,
  PanelRequest,
  Problem,
  OverlayBubbleTotals,
  Status,
} from "./shared/types";

/**
 * The service worker: the only part that holds the key or touches the network, and only
 * api.trenchscanner.app. Only the extension's own side panel is answered.
 *
 * No host permissions at all (the API allows its calls by CORS), no tabs, scripting or cookies.
 * Since 0.4.0 a content script rings alerts on Axiom, Terminal and GMGN (README "Rings"); it holds
 * no key and is answered from the panel's feed (handleContent). The panel lists the reader's alerts
 * and opens a token on a site as an ordinary link.
 *
 * TrenchScanner's own site (and only it: manifest externally_connectable, checked again here) may
 * ask whether the extension is installed and hand it a new key, so connecting needs no copy-paste.
 */

const KEY_SHAPE = /^tsx_[A-Za-z0-9_-]{43}$/;
/** The pages that may hand over a key (manifest externally_connectable lists the same). */
const WEB_ORIGINS = new Set(["https://trenchscanner.app", "https://www.trenchscanner.app"]);
/** The account's settings are re-read this often, so a change from another browser arrives. */
const SETTINGS_REFRESH_MS = 5 * 60_000;

interface Stored {
  key?: string;
  wallet?: string;
  settings?: OverlaySettings;
  aiReviews?: boolean;
  pro?: boolean;
  /**
   * The API refused the key (revoked, signing out of TrenchScanner revokes every key, or the
   * subscription ended). Kept in storage, not only in memory, so the site's ping still says
   * "not connected" after the worker restarts and Settings offers to connect again.
   */
  refused?: boolean;
}

let problem: Problem = null;
let settingsReadAt = 0;
let lastTokens: OverlayToken[] = [];
let lastBuddy: BuddyAnswer | null = null;
let feedReadAt = 0;
/** The ring pages' tabs, told when the settings change. */
const ringTabs = new Set<number>();
/** How long a ring page's answers reuse the last feed read (the panel polls every 5 s). */
const RING_FEED_MS = 10_000;
/** A tooltip's map totals are reused this long (a scan lands every few minutes at most). */
const TOTALS_MS = 60_000;
const totalsCache = new Map<string, { at: number; totals: OverlayBubbleTotals | null }>();
/** A coin page's map is reused this long (the panel re-reads an open map every 30 s). */
const PAGE_MAP_MS = 30_000;
const pageMaps = new Map<string, { at: number; answer: BubbleAnswer }>();

async function tooltipPrefs(): Promise<TooltipPrefs> {
  const { tooltip } = await chrome.storage.local.get("tooltip");
  return cleanTooltip(tooltip);
}

function tellRingTabs(message: object): void {
  for (const tabId of ringTabs)
    void chrome.tabs.sendMessage(tabId, message).catch(() => ringTabs.delete(tabId));
}

// The toolbar icon (and its shortcut) opens the panel beside the page.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

async function stored(): Promise<Stored> {
  return (await chrome.storage.local.get([
    "key",
    "wallet",
    "settings",
    "aiReviews",
    "pro",
    "refused",
  ])) as Stored;
}

async function currentSettings(): Promise<OverlaySettings> {
  const { key, settings } = await stored();
  if (key && Date.now() - settingsReadAt >= SETTINGS_REFRESH_MS) {
    settingsReadAt = Date.now();
    void api
      .me(key)
      .then((me) =>
        chrome.storage.local.set({
          wallet: me.wallet,
          settings: me.settings,
          aiReviews: me.aiReviews === true,
          pro: me.pro === true,
        }),
      )
      .catch((e: unknown) => noteFailure(e));
  }
  return settings ?? DEFAULT_SETTINGS;
}

function noteFailure(e: unknown): void {
  const refused = e instanceof ApiError && (e.status === 401 || e.status === 403);
  problem = refused ? "refused" : "offline";
  if (refused) void chrome.storage.local.set({ refused: true });
}

async function feed(): Promise<FeedAnswer> {
  const { key } = await stored();
  if (!key) return { tokens: [], problem: "disconnected" };
  try {
    lastTokens = (await api.feed(key)).tokens;
    feedReadAt = Date.now();
    problem = null;
    void chrome.storage.local.remove("refused");
  } catch (e) {
    noteFailure(e);
  }
  return { tokens: lastTokens, problem };
}

/**
 * Held until an open map's coin has a new reading (shared/follow.ts), or null when the ask failed.
 * A new reading drops the coin's cached map and totals, so the read that follows gets it.
 */
async function bubbleWait(mint: unknown): Promise<{ changed: boolean; pushed: boolean } | null> {
  const { key, refused } = await stored();
  if (!key || refused || typeof mint !== "string" || !isMintAddress(mint)) return null;
  try {
    const answer = await api.bubbleWait(key, mint);
    if (answer.changed) {
      pageMaps.delete(mint);
      totalsCache.delete(mint);
    }
    return answer;
  } catch {
    return null;
  }
}

/** A coin's latest bubble map. Only a valid mint is asked for, so nothing else reaches the URL. */
async function bubble(mint: unknown): Promise<BubbleAnswer> {
  const { key } = await stored();
  if (!key) return { map: null, problem: "disconnected" };
  if (typeof mint !== "string" || !isMintAddress(mint)) return { map: null, problem: "untracked" };
  try {
    const { map } = await api.bubble(key, mint);
    return { map, problem: null };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { map: null, problem: "untracked" };
    noteFailure(e);
    return { map: null, problem };
  }
}

/**
 * Trade Buddy: the coins the account's wallet bought, with their PnL. The last answer is kept in
 * session storage (cleared when the browser closes), so a reopened panel draws it at once while
 * the fresh read runs; `cached` asks for that alone.
 */
async function buddy(cached = false): Promise<BuddyRead> {
  const { key } = await stored();
  if (!key) return { buddy: null, problem: "disconnected" };
  if (!lastBuddy) {
    const { buddy: kept } = (await chrome.storage.session.get("buddy").catch(() => ({}))) as {
      buddy?: BuddyAnswer;
    };
    lastBuddy = kept ?? null;
  }
  if (cached) return { buddy: lastBuddy, problem };
  try {
    lastBuddy = await api.buddy(key);
    problem = null;
    void chrome.storage.session.set({ buddy: lastBuddy }).catch(() => undefined);
  } catch (e) {
    noteFailure(e);
  }
  return { buddy: lastBuddy, problem };
}

async function status(): Promise<Status> {
  const { key, wallet, aiReviews, pro, refused } = await stored();
  return {
    connected: Boolean(key),
    wallet: wallet ?? null,
    aiReviews: aiReviews === true,
    pro: pro === true,
    settings: await currentSettings(),
    problem: !key ? "disconnected" : refused && problem === null ? "refused" : problem,
  };
}

/** Checks a key TrenchScanner's Settings handed over with the API, and keeps it. */
async function connect(raw: unknown): Promise<{ ok: boolean; error?: string }> {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!KEY_SHAPE.test(key))
    return { ok: false, error: "That doesn't look like an extension key. It starts with tsx_." };
  try {
    const me = await api.me(key);
    await chrome.storage.local.set({
      key,
      wallet: me.wallet,
      settings: me.settings,
      aiReviews: me.aiReviews === true,
      pro: me.pro === true,
    });
    await chrome.storage.local.remove("refused");
    settingsReadAt = Date.now();
    problem = null;
    lastTokens = [];
    lastBuddy = null;
    void chrome.storage.session.remove("buddy").catch(() => undefined);
    // An open panel redraws connected.
    void chrome.runtime.sendMessage({ type: "connected" }).catch(() => undefined);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError && e.status === 403)
      return { ok: false, error: "This account needs a paid subscription to use the extension." };
    if (e instanceof ApiError && e.status === 401)
      return { ok: false, error: "That key isn't valid. It may have been revoked in Settings." };
    return { ok: false, error: "Couldn't reach TrenchScanner. Check your connection and try again." };
  }
}

async function handle(request: PanelRequest): Promise<unknown> {
  switch (request.type) {
    case "status":
      return status();
    case "feed":
      return feed();
    case "bubble":
      return bubble(request.mint);
    case "bubbleWait":
      return bubbleWait(request.mint);
    case "buddy":
      return buddy(request.cached === true);
    case "disconnect":
      await chrome.storage.local.remove(["key", "wallet", "aiReviews", "pro", "refused"]);
      lastTokens = [];
      lastBuddy = null;
      void chrome.storage.session.remove("buddy").catch(() => undefined);
      problem = "disconnected";
      return { ok: true };
    case "saveSettings": {
      const { key } = await stored();
      await chrome.storage.local.set({ settings: request.settings });
      tellRingTabs({ type: "settingsChanged", settings: request.settings });
      if (key) await api.saveSettings(key, request.settings).catch((e: unknown) => noteFailure(e));
      return { ok: true };
    }
    case "tooltip":
      return tooltipPrefs();
    case "saveTooltip": {
      const prefs = cleanTooltip(request.prefs);
      await chrome.storage.local.set({ tooltip: prefs });
      tellRingTabs({ type: "tooltipChanged", prefs });
      return { ok: true };
    }
    default:
      return null;
  }
}

/**
 * The rings (README "Rings"): the content script on Axiom, Terminal and GMGN asks
 * which addresses on screen are the reader's alerts. It is answered from the panel's own feed
 * (re-read when older than RING_FEED_MS), so no address from a page ever leaves the browser.
 */
async function handleContent(request: ContentRequest, tabId: number | undefined): Promise<unknown> {
  if (tabId !== undefined) ringTabs.add(tabId);
  switch (request.type) {
    case "settings":
      return currentSettings();
    case "lookup": {
      const answer = Date.now() - feedReadAt < RING_FEED_MS ? { tokens: lastTokens, problem } : await feed();
      const byMint = new Map(answer.tokens.map((t) => [t.mint, t]));
      const tokens: LookupAnswer["tokens"] = {};
      for (const mint of Array.isArray(request.mints) ? request.mints.slice(0, 100) : []) {
        const t = byMint.get(mint);
        if (t) tokens[mint] = t;
      }
      return { tokens, problem: answer.problem } satisfies LookupAnswer;
    }
    case "tooltip":
      return tooltipPrefs();
    case "alerts": {
      if (!(await tooltipPrefs()).toast.enabled) return null;
      return Date.now() - feedReadAt < RING_FEED_MS ? { tokens: lastTokens, problem } : await feed();
    }
    case "map": {
      // The coin the reader opened on the site: asked about only while they keep the map tab on.
      if (!(await tooltipPrefs()).mapTab.enabled || !isMintAddress(request.mint)) return null;
      const cached = pageMaps.get(request.mint);
      if (cached && Date.now() - cached.at < PAGE_MAP_MS) return cached.answer;
      const answer = await bubble(request.mint);
      if (answer.problem === null || answer.problem === "untracked") {
        if (pageMaps.size > 100) pageMaps.clear();
        pageMaps.set(request.mint, { at: Date.now(), answer });
      }
      return answer;
    }
    case "mapWait":
      // Only while the map tab is on, as "map" asks.
      if (!(await tooltipPrefs()).mapTab.enabled) return null;
      return bubbleWait(request.mint);
    case "totals": {
      // Only a coin already in the reader's alerts, so a page can't send other addresses out.
      if (!lastTokens.some((t) => t.mint === request.mint)) return null;
      const cached = totalsCache.get(request.mint);
      if (cached && Date.now() - cached.at < TOTALS_MS) return cached.totals;
      const { map, problem: failed } = await bubble(request.mint);
      if (failed && failed !== "untracked") return null;
      const totals = map?.totals ?? null;
      if (totalsCache.size > 200) totalsCache.clear();
      totalsCache.set(request.mint, { at: Date.now(), totals });
      return totals;
    }
    default:
      return null;
  }
}

/** A ring page: a tab of one of the three sites the manifest's content script runs on. */
const RING_HOSTS = /(^|\.)(axiom\.trade|padre\.gg|gmgn\.ai)$/;
function fromRingPage(sender: chrome.runtime.MessageSender): boolean {
  if (!sender.tab || typeof sender.url !== "string") return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "https:" && RING_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/** The extension's own pages: the side panel, or the panel opened in a tab. */
function fromPanel(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (typeof message !== "object" || message === null) return false;
  if (fromRingPage(sender)) {
    handleContent(message as ContentRequest, sender.tab?.id).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (!fromPanel(sender)) return false;
  handle(message as PanelRequest).then(sendResponse, () => sendResponse(null));
  return true;
});

/**
 * TrenchScanner's site: "ping" says the extension is here (and whether it has a key the API still
 * takes), so Settings can offer one-click connect, also to replace a refused key. A refused key
 * also names its account (the shortened wallet the panel shows), so the site, signed in again as
 * that account, reconnects without a click (user ask 2026-10-24). Disconnecting in the panel
 * forgets the account, so a browser disconnected on purpose stays disconnected; "connect" hands over a key Settings just made for it.
 */
chrome.runtime.onMessageExternal.addListener((message: unknown, sender, sendResponse) => {
  if (typeof sender.origin !== "string" || !WEB_ORIGINS.has(sender.origin)) return false;
  if (typeof message !== "object" || message === null) return false;
  const m = message as { type?: unknown; key?: unknown };
  const work =
    m.type === "ping"
      ? stored().then(({ key, refused, wallet }) => ({
          ok: true,
          connected: Boolean(key) && !refused,
          refusedAccount: key && refused ? (wallet ?? null) : null,
          version: chrome.runtime.getManifest().version,
        }))
      : m.type === "connect"
        ? connect(m.key)
        : null;
  if (!work) return false;
  work.then(sendResponse, () => sendResponse(null));
  return true;
});
