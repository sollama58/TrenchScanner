import { alertNotice, panelAlerts } from "./shared/alerts";
import { api, ApiError, type SavedLook } from "./shared/api";
import { isMintAddress } from "./shared/mint";
import { DEFAULT_SETTINGS } from "./shared/settings";
import {
  cleanTooltip,
  colorsOf,
  MAX_SNOOZE_MS,
  RUN_LEVELS,
  snoozed,
  type TooltipPrefs,
} from "./shared/tooltip";
import { firstAlert } from "./shared/verdict";
import { trenchUrl } from "./panel/card";
import type {
  ContentRequest,
  LookupAnswer,
  BubbleAnswer,
  BuddyAnswer,
  BuddyRead,
  CoinAnswer,
  FeedAnswer,
  OverlaySettings,
  OverlayToken,
  PanelRequest,
  Problem,
  OverlayBubbleTotals,
  OverlaySafety,
  SafetyAnswer,
  StatsAnswer,
  Status,
} from "./shared/types";

/**
 * The service worker: the only part that holds the key or touches the network, and only
 * api.trenchscanner.app. Only the extension's own side panel is answered.
 *
 * No host permissions at all (the API allows its calls by CORS), no tabs, scripting or cookies.
 * Since 0.4.0 a content script rings alerts on Axiom, Terminal and GMGN (README "Rings"); it holds
 * no key and is answered from the panel's feed (handleContent). The store build (`__STORE__`) has
 * no content script and no in-page frame, and answers neither. The panel lists the reader's alerts
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
/**
 * Up to this old, a ring page is answered from the last feed read at once while a fresh read runs
 * behind it, so a scroll never waits on the network (user ask 2026-10-26); the next ask gets it.
 */
const RING_STALE_MS = 120_000;
let feedInFlight: Promise<FeedAnswer> | null = null;

/** The feed for a ring page: the last read while fresh, or stale with a read started behind it. */
async function ringFeed(): Promise<FeedAnswer> {
  const age = Date.now() - feedReadAt;
  if (age < RING_FEED_MS) return { tokens: lastTokens, problem };
  feedInFlight ??= feed().finally(() => (feedInFlight = null));
  if (feedReadAt > 0 && age < RING_STALE_MS) return { tokens: lastTokens, problem };
  return feedInFlight;
}
/** A tooltip's map totals are reused this long (a scan lands every few minutes at most). */
const TOTALS_MS = 60_000;
const totalsCache = new Map<string, { at: number; totals: OverlayBubbleTotals | null }>();
/** A coin's safety verdict is reused this long across tabs (the API's own cache is 20 s). */
const SAFETY_MS = 15_000;
const safetyCache = new Map<string, { at: number; verdict: OverlaySafety | null }>();

/**
 * The display choices (tooltip, pills, colours, toasts, safety screen, holder markers, each
 * model's ring) are kept with the account too, so a reinstall or another browser gets them back
 * (user ask 2026-10-25). The newer of this browser's and the account's wins, by when each was
 * saved: a fresh install has none of its own, so it takes the account's; an account with none yet
 * gets this browser's.
 */
async function syncLook(key: string, remote: SavedLook | null | undefined): Promise<void> {
  const { tooltip, tooltipSavedAt } = (await chrome.storage.local.get(["tooltip", "tooltipSavedAt"])) as {
    tooltip?: unknown;
    tooltipSavedAt?: number;
  };
  const local = typeof tooltipSavedAt === "number" ? tooltipSavedAt : 0;
  const theirs = remote && typeof remote.savedAt === "number" ? remote.savedAt : 0;
  if (remote && theirs > local) {
    const prefs = cleanTooltip(remote.prefs);
    await chrome.storage.local.set({ tooltip: prefs, tooltipSavedAt: theirs });
    tellRingTabs({ type: "tooltipChanged", prefs });
    void chrome.runtime.sendMessage({ type: "lookChanged" }).catch(() => undefined);
  } else if (tooltip !== undefined && (local > theirs || !remote)) {
    // Choices made before 0.7.1 carry no time: they are saved as of now.
    const savedAt = local || Date.now();
    if (!local) await chrome.storage.local.set({ tooltipSavedAt: savedAt });
    await api.saveLook(key, { savedAt, prefs: cleanTooltip(tooltip) }).catch(() => undefined);
  }
}

/** Saves the display choices here and with the account, and tells every tab and the panel. */
async function saveTooltip(raw: unknown): Promise<TooltipPrefs> {
  const prefs = cleanTooltip(raw);
  const savedAt = Date.now();
  await chrome.storage.local.set({ tooltip: prefs, tooltipSavedAt: savedAt });
  tellRingTabs({ type: "tooltipChanged", prefs });
  // The icon's count follows the options at once (its switch, the unsafe coins left out).
  void noteAlerts(lastTokens);
  const { key, refused } = await stored();
  if (key && !refused) void api.saveLook(key, { savedAt, prefs }).catch(() => undefined);
  return prefs;
}

/**
 * Snoozes a coin (user ask 2026-10-27): no ring, pill, card, toast or notification for it until it
 * wakes; 0 minutes wakes it now. From a tooltip's button or a panel card.
 */
async function snooze(mint: unknown, minutes: unknown): Promise<void> {
  if (typeof mint !== "string" || !isMintAddress(mint)) return;
  const ms = typeof minutes === "number" && Number.isFinite(minutes) ? minutes * 60_000 : 0;
  const prefs = await tooltipPrefs();
  const next = { ...prefs.snoozed };
  if (ms > 0) next[mint] = Date.now() + Math.min(ms, MAX_SNOOZE_MS);
  else delete next[mint];
  await saveTooltip({ ...prefs, snoozed: next });
  void chrome.runtime.sendMessage({ type: "lookChanged" }).catch(() => undefined);
}

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
      .then(async (me) => {
        await chrome.storage.local.set({
          wallet: me.wallet,
          settings: me.settings,
          aiReviews: me.aiReviews === true,
          pro: me.pro === true,
        });
        await syncLook(key, me.look);
      })
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
    void noteAlerts(lastTokens);
  } catch (e) {
    noteFailure(e);
  }
  return { tokens: lastTokens, problem };
}

/**
 * New alerts while the panel is closed (user ask 2026-10-25): a Chrome notification for each, if
 * the reader turned them on, and the count of alerts the panel hasn't shown on the toolbar icon.
 * The feed is read once a minute for them (the "alerts" alarm), and only while one of them is on;
 * an open panel's reads count too. The alerts are the ones the panel lists (shared/alerts.ts).
 */
const NOTIFIED_MAX = 300;
/** At most this many notifications from one read; past it, one says how many came. */
const NOTIFY_AT_ONCE = 3;
let alertsWork: Promise<void> = Promise.resolve();

function noteAlerts(tokens: readonly OverlayToken[], read: readonly string[] = []): Promise<void> {
  alertsWork = alertsWork.then(() => checkAlerts(tokens, read)).catch(() => undefined);
  return alertsWork;
}

async function checkAlerts(tokens: readonly OverlayToken[], newlyRead: readonly string[]): Promise<void> {
  const prefs = await tooltipPrefs();
  const { key, aiReviews } = await stored();
  if (!key) return void chrome.action.setBadgeText({ text: "" });
  // Nothing read yet since the worker started: an empty list here is not the reader's feed.
  if (feedReadAt === 0) return;
  const saved = await currentSettings();
  // As the panel does: without the AI's verdicts, "only when the AI says buy" would hide every call.
  const settings = aiReviews ? saved : { ...saved, rings: { ...saved.rings, aiBuyOnly: false } };
  const listed = panelAlerts(tokens, settings, prefs.panel).map(({ token }) => token);
  const shown = listed.filter((t) => !snoozed(prefs, t.mint));
  await checkRuns(shown, prefs);
  const { alertsNotified, alertsRead } = (await chrome.storage.local.get([
    "alertsNotified",
    "alertsRead",
  ])) as {
    alertsNotified?: string[];
    alertsRead?: string[];
  };
  // The first read only marks what is already there.
  const notified = new Set(alertsNotified ?? shown.map((t) => t.mint));
  const read = new Set([...(alertsRead ?? shown.map((t) => t.mint)), ...newlyRead]);
  const fresh = shown.filter((t) => !notified.has(t.mint));
  if (prefs.panel.notify && fresh.length > 0) {
    for (const token of fresh.slice(0, NOTIFY_AT_ONCE)) {
      const { title, message } = alertNotice(token);
      chrome.notifications.create(`alert:${token.mint}`, {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title,
        message,
      });
    }
    if (fresh.length > NOTIFY_AT_ONCE)
      chrome.notifications.create("alerts:more", {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: `${fresh.length - NOTIFY_AT_ONCE} more new alerts`,
        message: "Open the panel to see them all.",
      });
  }
  // A snoozed coin's alert is marked too, so it doesn't arrive as new when the snooze ends.
  for (const t of listed) notified.add(t.mint);
  const unread = shown.filter((t) => !read.has(t.mint)).length;
  await chrome.storage.local.set({
    alertsNotified: [...notified].slice(-NOTIFIED_MAX),
    alertsRead: [...read].slice(-NOTIFIED_MAX),
  });
  await chrome.action.setBadgeBackgroundColor({ color: colorsOf(prefs).model });
  await chrome.action.setBadgeText({
    text: prefs.panel.badge && unread > 0 ? String(Math.min(unread, 99)) : "",
  });
}

/**
 * Run alerts (user ask 2026-10-27): a notification when one of the reader's alerts reaches a
 * multiple of its alert's market cap (its peak counts, so a spike between reads isn't missed),
 * each level once per coin, and when it falls the reader's share below it, once. What is already
 * past a level when the option is turned on, or when the worker first sees the coin with it on,
 * is only marked.
 */
const RUNS_MAX = 300;
/** The leaderboard's win window: 2x within 15 minutes of the alert (before a -50% stop). */
const GRADE_WINDOW_MS = 15 * 60_000;

async function checkRuns(tokens: readonly OverlayToken[], prefs: TooltipPrefs): Promise<void> {
  const { runsNotified } = (await chrome.storage.local.get("runsNotified")) as {
    runsNotified?: Record<string, { level: number; dropped: boolean }>;
  };
  if (!prefs.runs.enabled) {
    if (runsNotified) await chrome.storage.local.remove("runsNotified");
    return;
  }
  const first = runsNotified === undefined;
  const marks = { ...(runsNotified ?? {}) };
  const levels = RUN_LEVELS.filter((l) => prefs.runs.levels[l]);
  for (const token of tokens) {
    const alert = firstAlert(token);
    const at = alert?.mcapUsd ?? null;
    const now = token.liveMcapUsd ?? token.stats?.marketCapUsd ?? null;
    if (at === null || at <= 0 || now === null) continue;
    const peaks = [...token.modelCalls, ...token.filterMatches].map((a) => a.peakMcapUsd ?? 0);
    const best = Math.max(now, ...peaks) / at;
    const reached = levels.filter((l) => best >= l).pop() ?? 0;
    const dropped = prefs.runs.dropPct > 0 && now <= at * (1 - prefs.runs.dropPct / 100);
    const mark = marks[token.mint];
    if (!mark) {
      // New to the list: what it already did is marked; a fresh alert sits near 1x anyway.
      marks[token.mint] = { level: reached, dropped };
      if (first) continue;
      if (reached === 0 && !dropped) continue;
    } else if (reached <= mark.level && (!dropped || mark.dropped)) continue;
    const coin = token.symbol ?? `${token.mint.slice(0, 4)}…${token.mint.slice(-4)}`;
    if (reached > (mark?.level ?? 0)) {
      // Worded as a peak, not a win (audit EX-8, user decision 2026-10-27): the leaderboard counts a
      // win only for 2x within 15 minutes of the alert and before a -50% stop, and a quarter of the
      // calls that peak 2x later are graded misses.
      const late = alert !== undefined && Date.now() - Date.parse(alert.at) > GRADE_WINDOW_MS;
      chrome.notifications.create(`alert:${token.mint}:run${reached}`, {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: `${coin} peaked ${reached}x after its alert`,
        message: `Alerted at ${usdShort(at)}, ${now >= at * reached ? "now" : "peaked past"} ${usdShort(
          Math.max(now, at * reached),
        )}.${late ? " Over 15 minutes after the alert, so not a leaderboard win." : ""}`,
      });
    }
    if (dropped && !mark?.dropped) {
      chrome.notifications.create(`alert:${token.mint}:drop`, {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: `${coin} is down ${Math.round((1 - now / at) * 100)}% from its alert`,
        message: `Alerted at ${usdShort(at)}, now ${usdShort(now)}.`,
      });
    }
    marks[token.mint] = { level: Math.max(reached, mark?.level ?? 0), dropped: dropped || !!mark?.dropped };
  }
  const kept = Object.entries(marks).slice(-RUNS_MAX);
  await chrome.storage.local.set({ runsNotified: Object.fromEntries(kept) });
}

function usdShort(value: number): string {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

chrome.alarms.create("alerts", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "alerts") return;
  void (async () => {
    const { panel, runs } = await tooltipPrefs();
    if (!panel.notify && !panel.badge && !runs.enabled) return;
    // An open panel read the feed moments ago.
    if (Date.now() - feedReadAt < 30_000) return;
    await feed();
  })();
});

// A notification opens its coin on TrenchScanner; the "more" one opens nothing (the panel can't
// be opened from here without a click on the page).
chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  // A run alert's id carries its level after the mint.
  const mint = id.startsWith("alert:") ? id.slice("alert:".length).split(":")[0]! : null;
  if (mint && isMintAddress(mint)) void chrome.tabs.create({ url: trenchUrl(mint) });
});

/** Any coin by its address, for the panel's lookup: its card and its bubble map's top holders. */
async function coin(mint: unknown): Promise<CoinAnswer> {
  const { key } = await stored();
  if (!key) return { token: null, map: null, problem: "disconnected" };
  if (typeof mint !== "string" || !isMintAddress(mint)) return { token: null, map: null, problem: null };
  const [card, map] = await Promise.all([
    api.token(key, mint).then(
      ({ token }) => ({ token, failed: false }),
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 401) noteFailure(e);
        return { token: null, failed: true };
      },
    ),
    bubble(mint),
  ]);
  const offline = card.failed && map.problem !== null && map.problem !== "untracked";
  return { token: card.token, map: map.map, problem: offline ? "offline" : null };
}

/** A coin's board stats are reused this long across tabs (the API's own cache is 20 s). */
const STATS_MS = 20_000;
const statsCache = new Map<string, { at: number; token: OverlayToken | null }>();

/**
 * Live board pills (user ask 2026-10-27): the coins the boards asked about lately, and the tab
 * that showed each. One held ask (POST /stats/wait) at a time names them; when the scanner writes
 * one's new snapshot the API answers at once, and its new numbers go straight to its tab. The
 * boards' own 30-second re-ask stays as the fallback.
 */
const BOARD_LIVE_MS = 90_000;
const BOARD_LIVE_MAX = 300;
const BOARD_LIVE_GAP_MS = 3_000;
const boardMints = new Map<string, { at: number; tabId: number | undefined }>();
let boardLive = false;

function startBoardLive(): void {
  if (boardLive) return;
  boardLive = true;
  void runBoardLive().finally(() => (boardLive = false));
}

async function runBoardLive(): Promise<void> {
  let failures = 0;
  for (;;) {
    const now = Date.now();
    for (const [mint, v] of boardMints) if (now - v.at > BOARD_LIVE_MS) boardMints.delete(mint);
    const prefs = await tooltipPrefs();
    const { key, refused } = await stored();
    if (
      boardMints.size === 0 ||
      !key ||
      refused ||
      (!prefs.boardStats.enabled && prefs.limits.mode === "off")
    )
      return;
    const mints = [...boardMints]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, BOARD_LIVE_MAX)
      .map(([m]) => m);
    const asked = Date.now();
    try {
      const answer = await api.statsWait(key, mints);
      failures = 0;
      const tokens: StatsAnswer["tokens"] = {};
      const at = Date.now();
      for (const [mint, got] of Object.entries(answer.tokens)) {
        const token: OverlayToken = { ...got, modelCalls: [], filterMatches: [], ai: null };
        statsCache.set(mint, { at, token });
        tokens[mint] = token;
      }
      const byTab = new Map<number, StatsAnswer["tokens"]>();
      for (const [mint, token] of Object.entries(tokens)) {
        const tabId = boardMints.get(mint)?.tabId;
        if (tabId === undefined) continue;
        byTab.set(tabId, { ...byTab.get(tabId), [mint]: token });
      }
      for (const [tabId, part] of byTab)
        void chrome.tabs.sendMessage(tabId, { type: "boardStats", tokens: part }).catch(() => undefined);
      // No wait could be held there: the boards' own re-ask carries on, and this tries later.
      if (!answer.pushed) await new Promise((r) => setTimeout(r, 30_000));
      // A busy board's coins change every moment: asks go 3 s apart at least.
      else await new Promise((r) => setTimeout(r, Math.max(0, BOARD_LIVE_GAP_MS - (Date.now() - asked))));
    } catch (e) {
      // An API without the route: the boards' own re-ask is all there is.
      if (e instanceof ApiError && (e.status === 404 || e.status === 401 || e.status === 403)) return;
      failures += 1;
      await new Promise((r) => setTimeout(r, Math.min(60_000, 2_000 * 2 ** failures)));
    }
  }
}

/**
 * The stats of the coins on a board, for the option that puts the ring's pill on every coin
 * TrenchScanner has numbers for (user ask 2026-10-26). Only while it is on: then, and only then,
 * the board's addresses go to TrenchScanner, and nowhere else.
 */
async function boardStats(mints: unknown, tabId?: number): Promise<StatsAnswer | null> {
  const prefs = await tooltipPrefs();
  if (!prefs.boardStats.enabled && prefs.limits.mode === "off") return null;
  const { key, refused } = await stored();
  if (!key || refused) return { tokens: {}, problem: "disconnected" };
  const asked = [...new Set(Array.isArray(mints) ? mints : [])]
    .filter((m): m is string => typeof m === "string" && isMintAddress(m))
    .slice(0, 100);
  const now = Date.now();
  for (const mint of asked) boardMints.set(mint, { at: now, tabId });
  startBoardLive();
  const tokens: StatsAnswer["tokens"] = {};
  const missing: string[] = [];
  for (const mint of asked) {
    const hit = statsCache.get(mint);
    if (hit && now - hit.at < STATS_MS) {
      if (hit.token) tokens[mint] = hit.token;
    } else missing.push(mint);
  }
  if (missing.length > 0) {
    try {
      const answer = await api.stats(key, missing);
      if (statsCache.size > 5_000) statsCache.clear();
      for (const mint of missing) {
        const got = answer.tokens[mint];
        const token: OverlayToken | null = got
          ? { ...got, modelCalls: [], filterMatches: [], ai: null }
          : null;
        statsCache.set(mint, { at: now, token });
        if (token) tokens[mint] = token;
      }
    } catch (e) {
      // An older API without the route: no pills.
      if (e instanceof ApiError && e.status === 404) return { tokens, problem: null };
      if (e instanceof ApiError && e.status === 401) noteFailure(e);
      return { tokens, problem: e instanceof ApiError && e.status === 401 ? "refused" : "offline" };
    }
  }
  return { tokens, problem: null };
}

/**
 * The safety verdicts of the coins on a board, for the option that hides or marks the failing ones
 * (user ask 2026-10-25). Only while it is on: then, and only then, the board's addresses go to
 * TrenchScanner, and nowhere else.
 */
async function safety(mints: unknown): Promise<SafetyAnswer | null> {
  if ((await tooltipPrefs()).safety.mode === "off") return null;
  const { key, refused } = await stored();
  if (!key || refused) return { verdicts: {}, problem: "disconnected" };
  const asked = [...new Set(Array.isArray(mints) ? mints : [])]
    .filter((m): m is string => typeof m === "string" && isMintAddress(m))
    .slice(0, 100);
  const now = Date.now();
  const verdicts: SafetyAnswer["verdicts"] = {};
  const missing: string[] = [];
  for (const mint of asked) {
    const hit = safetyCache.get(mint);
    if (hit && now - hit.at < SAFETY_MS) {
      if (hit.verdict) verdicts[mint] = hit.verdict;
    } else missing.push(mint);
  }
  if (missing.length > 0) {
    try {
      const answer = await api.safety(key, missing);
      if (safetyCache.size > 5_000) safetyCache.clear();
      for (const mint of missing) {
        const verdict = answer.verdicts[mint] ?? null;
        safetyCache.set(mint, { at: now, verdict });
        if (verdict) verdicts[mint] = verdict;
      }
    } catch (e) {
      // An older API without the route: nothing is hidden.
      if (e instanceof ApiError && e.status === 404) return { verdicts, problem: null };
      if (e instanceof ApiError && e.status === 401) noteFailure(e);
      return { verdicts, problem: e instanceof ApiError && e.status === 401 ? "refused" : "offline" };
    }
  }
  return { verdicts, problem: null };
}

/** The answer the site map gets when its read could not be made (map/siteMap.ts). */
const NO_SITE = (status: number, error: string) => ({ status, body: JSON.stringify({ error }) });

/**
 * One API call of the site's own bubble map (map/siteMap.ts), made through the key: the API
 * replays it as the key's owner if it is one of the map's reads, and refuses anything else
 * (apps/api/src/extensionSite.ts). Status and body come back as the API sent them.
 */
async function site(
  request: Extract<PanelRequest, { type: "site" }>,
): Promise<{ status: number; body: string }> {
  // Registered before anything is awaited, so a cancel sent right after the read still finds it.
  const id = typeof request.id === "string" && request.id.length <= 64 ? request.id : null;
  const abort = new AbortController();
  if (id) siteCalls.set(id, abort);
  try {
    const { key, refused } = await stored();
    if (!key || refused) return NO_SITE(401, "disconnected");
    const { method, path, body } = request;
    if (typeof method !== "string" || typeof path !== "string" || !path.startsWith("/"))
      return NO_SITE(400, "bad_call");
    if (body !== null && typeof body !== "string") return NO_SITE(400, "bad_call");
    if (abort.signal.aborted) return NO_SITE(499, "cancelled");
    return await api.site(key, { method, path, body }, abort.signal);
  } catch (e) {
    if (abort.signal.aborted) return NO_SITE(499, "cancelled");
    if (!(e instanceof ApiError)) return NO_SITE(503, "offline");
    // A refused key is the panel's problem too; a refused call is only this map's.
    if (e.status === 401) noteFailure(e);
    return NO_SITE(e.status, e.message);
  } finally {
    if (id && siteCalls.get(id) === abort) siteCalls.delete(id);
  }
}

/**
 * The map reads in flight, by the id the map gave each (siteMap.ts), so a map that gives a read up
 * stops it at the API too: the API ends a held wait when its request closes (audit EX-10).
 */
const siteCalls = new Map<string, AbortController>();

/** Cancels the map read with this id, if it is still in flight. */
function cancelSite(id: unknown): { ok: boolean } {
  const abort = typeof id === "string" ? siteCalls.get(id) : undefined;
  abort?.abort();
  return { ok: abort !== undefined };
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
    lastBuddy = await api.buddy(key, (await tooltipPrefs()).buddyWallets);
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
    // Another account's alerts were notified and read, not this one's.
    await chrome.storage.local.remove(["refused", "alertsNotified", "alertsRead"]);
    await syncLook(key, me.look);
    settingsReadAt = Date.now();
    problem = null;
    lastTokens = [];
    feedReadAt = 0;
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
    case "site":
      return site(request);
    case "siteCancel":
      return cancelSite(request.id);
    case "buddy":
      return buddy(request.cached === true);
    case "coin":
      return coin(request.mint);
    case "alertsSeen":
      await noteAlerts(
        lastTokens,
        Array.isArray(request.mints) ? request.mints.filter((m) => typeof m === "string") : [],
      );
      return { ok: true };
    case "disconnect":
      await chrome.storage.local.remove([
        "key",
        "wallet",
        "aiReviews",
        "pro",
        "refused",
        "alertsNotified",
        "alertsRead",
      ]);
      void chrome.action.setBadgeText({ text: "" });
      lastTokens = [];
      feedReadAt = 0;
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
    case "saveTooltip":
      await saveTooltip(request.prefs);
      return { ok: true };
    case "snooze":
      await snooze(request.mint, request.minutes);
      return { ok: true };
    case "pendingCoin": {
      const { pendingCoin } = (await chrome.storage.session.get("pendingCoin").catch(() => ({}))) as {
        pendingCoin?: { mint: string; at: number };
      };
      await chrome.storage.session.remove("pendingCoin").catch(() => undefined);
      // A Look up asked for long ago was never opened: it isn't shown out of the blue later.
      return pendingCoin && Date.now() - pendingCoin.at < 60_000 ? pendingCoin.mint : null;
    }
    default:
      return null;
  }
}

/**
 * The rings (README "Rings"): the content script on Axiom, Terminal and GMGN asks
 * which addresses on screen are the reader's alerts. It is answered from the panel's own feed
 * (re-read when older than RING_FEED_MS), so no ring sends an address from a page. The safety
 * option (`safety`) and the coin-page tools (`holders`, the map tab) do, only while they are on.
 */
async function handleContent(request: ContentRequest, tabId: number | undefined): Promise<unknown> {
  if (tabId !== undefined) ringTabs.add(tabId);
  switch (request.type) {
    case "settings":
      return currentSettings();
    case "lookup": {
      const answer = await ringFeed();
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
      return ringFeed();
    }
    case "safety":
      return safety(request.mints);
    case "stats":
      return boardStats(request.mints, tabId);
    case "snooze":
      await snooze(request.mint, request.minutes);
      return { ok: true };
    case "openCoin": {
      if (typeof request.mint !== "string" || !isMintAddress(request.mint)) return null;
      await chrome.storage.session.set({ pendingCoin: { mint: request.mint, at: Date.now() } });
      // An open panel turns to it now; a closed one takes it as it opens.
      void chrome.runtime.sendMessage({ type: "openCoin", mint: request.mint }).catch(() => undefined);
      return { ok: true };
    }
    case "holders": {
      // Only the open coin's page, and only while the markers are on.
      if (!(await tooltipPrefs()).holderMarks.enabled) return null;
      const { map } = await bubble(request.mint);
      return map;
    }
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

/** One of the extension's pages framed inside a site's page: the map tab's frame. */
function inPageFrame(sender: chrome.runtime.MessageSender): boolean {
  return (sender.frameId ?? 0) !== 0 && !(sender.tab?.url ?? "").startsWith(chrome.runtime.getURL(""));
}

/** The extension's own pages: the side panel, or the panel opened in a tab. */
function fromPanel(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (typeof message !== "object" || message === null) return false;
  if (!__STORE__ && fromRingPage(sender)) {
    // Opened here, before anything is awaited, while the click that asked still counts as one.
    if ((message as { type?: unknown }).type === "openCoin" && sender.tab?.id !== undefined)
      void chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => undefined);
    handleContent(message as ContentRequest, sender.tab?.id).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (!fromPanel(sender)) return false;
  // The bubble map tab's frame on a coin's page (content/mapTab.ts): its map's reads only, and
  // only while the reader keeps the tab on.
  if (inPageFrame(sender)) {
    if (__STORE__) return false;
    const request = message as PanelRequest;
    if (request.type === "siteCancel") {
      sendResponse(cancelSite(request.id));
      return false;
    }
    if (request.type !== "site") return false;
    tooltipPrefs()
      .then((prefs) => (prefs.mapTab.enabled ? site(request) : NO_SITE(403, "map_tab_off")))
      .then(sendResponse, () => sendResponse(null));
    return true;
  }
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
