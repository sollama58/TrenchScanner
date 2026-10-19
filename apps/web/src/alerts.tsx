import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { post, put, type AlertPrefs, type Card, type MatchPage, type Settings } from "./api";
import { cachedGet, peek } from "./cache";
import { useNudgeStream } from "./hooks";
import { playAlertSound, unlockAudio } from "./alertSounds";
import { tokenThumb, usd } from "./format";
import { adoptAppearance, appearanceVersion, useAppearance } from "./appearance";
import { adoptHiddenTokens, hiddenTokensVersion } from "./hiddenTokens";
import { adoptScopeSettings, scopeSettingsVersion } from "./scopeSettings";
import { openChaosTabs, thisBrowserIsDesktop } from "./chaosMode";
import { belowMcapLine } from "./components/AlertCard";

/**
 * Alert delivery in the dashboard: the user's alert settings (shared by the Settings tab and the
 * notifier, so a change applies at once) and the notifier that pings and raises browser
 * notifications for new alerts in their feed - the same feed the Live tab shows (their filter's
 * matches, plus the calls of the models they follow).
 */

export const SETTINGS_PATH = "/settings";

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  soundEnabled: true,
  sound: "chime",
  volume: 60,
  browserNotifications: false,
  notifyOn: { filterMatches: true, modelCalls: true },
  chaosMode: false,
  chaosSite: null,
  chaosPerMinute: 10,
};

// ---- The settings store ----

let settings: Settings | null = peek<Settings>(SETTINGS_PATH)?.data ?? null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Loads (or reloads) the settings; errors leave the last ones in place. */
export function loadSettings(force = false): Promise<void> {
  if (loading && !force) return loading;
  const lookVersion = appearanceVersion();
  const hiddenVersion = hiddenTokensVersion();
  const scopeVersion = scopeSettingsVersion();
  loading = cachedGet<Settings>(SETTINGS_PATH, force ? -1 : 0)
    .then((s) => {
      // An alert-pref save made while this was in flight is newer than its answer: keep those.
      settings = savesInFlight > 0 && settings ? { ...s, alerts: settings.alerts } : s;
      loadedAt = Date.now();
      // The feed's look rides along; a change made on this device since the request wins.
      adoptAppearance(s.appearance, lookVersion);
      adoptHiddenTokens(s.hiddenTokens, hiddenVersion);
      adoptScopeSettings(s.scopeSettings, scopeVersion);
      emit();
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Forgets the loaded settings, on sign-out or sign-in, so one wallet's never show for another. */
export function resetSettings(): void {
  settings = null;
  loading = null;
  emit();
}

/** When the settings last loaded (ms), for refreshSettingsIfOld. */
let loadedAt = 0;
/** Alert-pref saves still in flight: a reload then could answer from before them. */
let savesInFlight = 0;
/** How old the settings may get before a returning or long-open tab reads them again. */
const SETTINGS_REFRESH_MS = 5 * 60_000;
let refreshHooked = false;

/**
 * Re-reads the settings once they are SETTINGS_REFRESH_MS old, so a change made on another device
 * (sound, notifications, Chaos Mode) reaches a tab that stays open. Checked when the tab comes back
 * and on a timer while it is visible; skipped while a save here is in flight.
 */
function refreshSettingsIfOld(): void {
  if (document.visibilityState !== "visible" || settings === null || savesInFlight > 0) return;
  if (Date.now() - loadedAt < SETTINGS_REFRESH_MS) return;
  void loadSettings(true).catch(() => undefined);
}

export function useSettings(): Settings | null {
  const s = useSyncExternalStore(subscribe, () => settings);
  useEffect(() => {
    void loadSettings().catch(() => undefined);
    if (!refreshHooked) {
      refreshHooked = true;
      document.addEventListener("visibilitychange", refreshSettingsIfOld);
      window.setInterval(refreshSettingsIfOld, 60_000);
    }
  }, []);
  return s;
}

let saveSeq = 0;

/** Saves a change to the alert settings; shown at once, rolled back if the save fails. */
export async function saveAlertPrefs(
  change: Partial<Omit<AlertPrefs, "notifyOn">> & {
    notifyOn?: Partial<AlertPrefs["notifyOn"]>;
  },
): Promise<void> {
  const before = settings;
  if (settings) {
    settings = {
      ...settings,
      alerts: {
        ...settings.alerts,
        ...change,
        notifyOn: { ...settings.alerts.notifyOn, ...(change.notifyOn ?? {}) },
      },
    };
    emit();
  }
  const seq = ++saveSeq;
  savesInFlight++;
  try {
    const res = await put<{ alerts: AlertPrefs }>(`${SETTINGS_PATH}/alerts`, change).finally(() => {
      savesInFlight--;
    });
    // Only the latest save's answer: an older one landing late would flip a newer toggle back.
    if (settings && seq === saveSeq) {
      settings = { ...settings, alerts: res.alerts };
      emit();
    }
  } catch (e) {
    // Undo only this change, keeping any made since.
    if (settings && before) {
      const { notifyOn, ...rest } = change;
      const undo = Object.fromEntries(
        Object.keys(rest).map((k) => [k, before.alerts[k as keyof typeof rest]]),
      ) as Partial<AlertPrefs>;
      const undoNotify = Object.fromEntries(
        Object.keys(notifyOn ?? {}).map((k) => [
          k,
          before.alerts.notifyOn[k as keyof AlertPrefs["notifyOn"]],
        ]),
      );
      settings = {
        ...settings,
        alerts: {
          ...settings.alerts,
          ...undo,
          notifyOn: { ...settings.alerts.notifyOn, ...undoNotify },
        },
      };
      emit();
    }
    throw e;
  }
}

// ---- Browser notifications ----

export type NotificationState = "unsupported" | "default" | "granted" | "denied";

export function notificationState(): NotificationState {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Asks for permission (must be called from a click). */
export async function requestNotifications(): Promise<NotificationState> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationState();
  }
}

/** The service worker that shows notifications (public/sw.js); null where there is none. */
let worker: Promise<ServiceWorkerRegistration | null> | null = null;

function notificationWorker(): Promise<ServiceWorkerRegistration | null> {
  if (worker) return worker;
  worker =
    typeof navigator !== "undefined" && "serviceWorker" in navigator && window.isSecureContext
      ? navigator.serviceWorker.register("/sw.js").catch(() => null)
      : Promise.resolve(null);
  return worker;
}

/** Registers the notification worker early, so the first alert doesn't wait on it. */
export function prepareNotifications(): void {
  if (notificationState() === "granted") void notificationWorker();
}

// ---- Push notifications ----

/**
 * Whether this browser is subscribed to push for the signed-in account. While it is, alerts
 * arrive as push notifications (the worker's web-push-dispatch, with this page closed or the
 * phone locked too), so the open page only plays its sound and doesn't notify a second time.
 */
let pushActive = false;

export function pushIsActive(): boolean {
  return pushActive;
}

/** Whether this browser can take push at all (iOS: only from the Home Screen app, 16.4+). */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

let pushSync: Promise<void> = Promise.resolve();

/**
 * Subscribes this browser to push and registers it with the account when notifications are on
 * and allowed, or unsubscribes it when they aren't. Safe to call often (every settings change and
 * page load); calls run one after another. Called straight from the switch's click too, since
 * Safari only lets a page subscribe inside a user gesture.
 */
export function syncPush(publicKey: string | null | undefined, wanted: boolean): Promise<void> {
  pushSync = pushSync
    .then(() => doSyncPush(publicKey ?? null, wanted))
    .catch(() => {
      pushActive = false;
    });
  return pushSync;
}

async function doSyncPush(publicKey: string | null, wanted: boolean): Promise<void> {
  if (!pushSupported()) {
    pushActive = false;
    return;
  }
  const registration = await notificationWorker();
  if (!registration) {
    pushActive = false;
    return;
  }
  const existing = await registration.pushManager.getSubscription();
  const on = wanted && publicKey !== null && notificationState() === "granted";
  if (!on) {
    pushActive = false;
    if (existing) {
      await post("/settings/push/remove", { endpoint: existing.endpoint }).catch(() => undefined);
      await existing.unsubscribe().catch(() => false);
    }
    return;
  }
  const key = urlBase64ToBytes(publicKey);
  let sub = existing;
  // A subscription made with an older key can't be sent to with the new one.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  sub ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await put("/settings/push", sub.toJSON());
  pushActive = true;
}

export type NotifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Shows one notification: through the service worker where there is one (the only way on Chrome
 * for Android, and the same on desktop), else with `new Notification`. Resolves with why it
 * failed, so the Settings tab can say so instead of failing silently.
 */
export async function showNotification(
  title: string,
  body: string,
  icon: string | undefined,
  tag: string,
): Promise<NotifyResult> {
  const state = notificationState();
  if (state === "unsupported")
    return { ok: false, reason: "This browser can't show notifications from a page." };
  if (state !== "granted") return { ok: false, reason: "Notifications aren't allowed for this site yet." };
  // renotify: a notification with a tag already on screen replaces it silently otherwise.
  const options: NotificationOptions & { renotify?: boolean } = { body, icon, tag, renotify: true };
  let workerError: unknown = null;
  try {
    const registration = await notificationWorker();
    if (registration) {
      const ready = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (ready) {
        await ready.showNotification(title, options);
        return { ok: true };
      }
    }
  } catch (e) {
    workerError = e;
  }
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      if (window.location.hash !== "") window.location.hash = "";
      n.close();
    };
    return { ok: true };
  } catch (e) {
    const err = workerError ?? e;
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Plays the user's sound now (the Settings tab's sound and volume previews). */
export function previewAlert(prefs: AlertPrefs): void {
  unlockAudio();
  playAlertSound(prefs.sound, prefs.volume);
}

/** The test button: the sound (if on) and, when notifications are allowed, a test notification. */
export async function sendTestAlert(prefs: AlertPrefs): Promise<NotifyResult | null> {
  unlockAudio();
  if (prefs.soundEnabled) playAlertSound(prefs.sound, prefs.volume);
  if (notificationState() !== "granted") return null;
  // A fresh tag each time, so every test pops up rather than replacing the last one.
  return showNotification(
    "TrenchScanner test alert",
    "This is how a new alert will look.",
    undefined,
    `ts-test-${Date.now()}`,
  );
}

// ---- The notifier ----

const FEED_PATH = "/matches?page=1&includeCurated=saved";
/** Cards older than this when first seen are not news (a settings change brought them in). */
const FRESH_MS = 15 * 60_000;
/**
 * A card first seen now is news only if it was raised after the previous look (less this much
 * slack, for clock skew and a delayed check). Anything older that turns up now was brought in by
 * a change, not raised since: following another model shows its recent calls, and the default
 * model can switch to the best performer on its own - neither is a new alert to ping for.
 */
const SINCE_LAST_LOOK_SLACK_MS = 2 * 60_000;
/** The fallback check while no stream is up (and, throttled by the browser, in a hidden tab). */
const CHECK_EVERY_MS = 30_000;
/**
 * While both streams are up, every this many CHECK_EVERY_MS ticks still looks (5 min). A nudge
 * can be lost without the stream dropping (the API's database listener reconnecting misses what
 * was raised meanwhile); this bounds how long such an alert goes unannounced.
 */
const STREAM_BACKSTOP_TICKS = 10;
/** More new alerts than this at once become one summary notification. */
const MAX_NOTIFICATIONS = 3;
const NOTIFIED_KEY = "ts-notified-v1";
const NOTIFIED_KEEP = 200;

const cardKey = (c: Card) => `${c.kind}:${c.id}`;

/**
 * When a card became news: its own time, or for a filter alert wearing a model's call (folded, or
 * every card of "Only alerts both caught") the latest of that and its calls. Such a card first
 * shows when its second half lands - often a call after the filter alert - and keeps the filter
 * alert's older time, which alone read as a card brought in by a change and was learned silently.
 */
export function raisedAt(c: Card): number {
  const at = Date.parse(c.matchedAt);
  if (c.kind !== "match" || !c.curated) return at;
  const calls = c.curated.calledBy?.length ? c.curated.calledBy : [c.curated];
  return Math.max(at, ...calls.map((k) => Date.parse(k.alertedAt)));
}

/**
 * Whether the reader's choices want this card announced. A filter alert wearing a call is both,
 * so either choice does: with "Only alerts both caught" every card is one, and a reader who
 * wants model calls alone heard nothing.
 */
export function wantedBy(c: Card, notifyOn: AlertPrefs["notifyOn"]): boolean {
  if (c.kind === "curated") return notifyOn.modelCalls;
  return notifyOn.filterMatches || (c.curated !== null && notifyOn.modelCalls);
}

/**
 * Claims `keys` for this browser tab, so two open tabs don't both ping for the same alert, and
 * calls `then` with the ones no other tab had claimed. Under a cross-tab lock where the browser
 * has one: the same alert nudges every open tab at once, and without it two tabs could both read
 * the list before either wrote it, and both ping (chaosMode.ts does the same for its tabs).
 */
function claimThen(keys: string[], then: (mine: string[]) => void): void {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks) void locks.request("ts-notified", () => then(claim(keys)));
  else then(claim(keys));
}

/** claimThen without the lock: the keys no other tab has claimed, now claimed for this one. */
export function claim(keys: string[]): string[] {
  try {
    const stored: string[] = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "[]");
    const taken = new Set(stored);
    const mine = keys.filter((k) => !taken.has(k));
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...stored, ...mine].slice(-NOTIFIED_KEEP)));
    return mine;
  } catch {
    return keys;
  }
}

function describe(card: Card, now = Date.now()): { title: string; body: string } {
  const t = card.token;
  const name = t.symbol ? `$${t.symbol}` : (t.name ?? `${t.mintAddress.slice(0, 4)}…`);
  // "Called at" is the price the alert went out at (a call's anchor), not the latest reading: in a
  // call's first minute that reading still shows the market from before it. An alert seen late (a
  // laptop waking, a tab the browser held back) says how long ago it was raised, so that figure
  // isn't read as the market now.
  const mcap = card.snapshot?.marketCapUsd ?? null;
  const lateMin = Math.floor((now - raisedAt(card)) / 60_000);
  const when = lateMin >= 2 ? `, ${lateMin}m ago` : "";
  const at = mcap !== null ? ` at ${usd(mcap)} mcap${when}` : when;
  if (card.kind === "curated") {
    const model = card.curated?.modelName ?? "A model";
    return { title: `${name}: ${model} alert`, body: `${model} alerted on ${name}${at}.` };
  }
  return {
    title: `${name}: filter match`,
    body: `${card.filter?.name ? `"${card.filter.name}"` : "Your filter"} caught ${name}${at}.`,
  };
}

/**
 * Watches the user's feed and pings / notifies for each new alert. Rendered once, inside the
 * subscriber gate, on every tab - so alerts arrive whichever tab is open, and in the background.
 */
export function AlertNotifier() {
  const s = useSettings();
  const prefs = s?.alerts ?? null;
  const seen = useRef<Set<string> | null>(null);
  const lastLookAt = useRef(0);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const look = useAppearance();
  const lookRef = useRef(look);
  lookRef.current = look;

  const notifies = prefs !== null && prefs.browserNotifications && notificationState() === "granted";
  // Chaos Mode is desktop only, whatever the account says.
  const chaos = prefs !== null && prefs.chaosMode === true && thisBrowserIsDesktop();
  const active = prefs !== null && (prefs.soundEnabled || notifies || chaos);
  // Either stream can complete a card both caught (wantedBy), so either choice listens to both.
  // Chaos Mode opens every new alert in the feed, whichever the reader is pinged for.
  const listens = active && (chaos || prefs!.notifyOn.filterMatches || prefs!.notifyOn.modelCalls);

  // Browsers only allow sound after an interaction with the page, and phones put audio back to
  // sleep when the screen locks or the tab is hidden. Keep listening so every tap can wake it again.
  // Touch taps only count as a user gesture on pointerup/touchend/click, not pointerdown.
  useEffect(() => {
    prepareNotifications();
    const unlock = () => unlockAudio();
    const onVisible = () => {
      if (document.visibilityState === "visible") unlockAudio();
    };
    const events = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;
    for (const e of events) window.addEventListener(e, unlock, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      for (const e of events) window.removeEventListener(e, unlock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Push: subscribed while notifications are on and allowed, unsubscribed when they're not.
  const publicKey = s?.push?.publicKey ?? null;
  const wantsPush = prefs !== null && prefs.browserNotifications;
  const prefsLoaded = prefs !== null;
  useEffect(() => {
    if (prefsLoaded) void syncPush(publicKey, wantsPush);
  }, [publicKey, wantsPush, notifies, prefsLoaded]);

  const busy = useRef(false);
  const again = useRef(false);

  const lookAt = useCallback((maxAgeMs: number) => {
    busy.current = true;
    cachedGet<MatchPage>(FEED_PATH, maxAgeMs)
      .then((page) => {
        const cards = page.matches;
        const now = Date.now();
        const previousLook = lastLookAt.current;
        lastLookAt.current = now;
        if (seen.current === null) {
          // The first look only learns what is already there.
          seen.current = new Set(cards.map(cardKey));
          return;
        }
        const p = prefsRef.current;
        const fresh = cards.filter((c) => !seen.current!.has(cardKey(c)));
        for (const c of fresh) seen.current.add(cardKey(c));
        if (!p) return;
        const raisedAfter = Math.max(now - FRESH_MS, previousLook - SINCE_LAST_LOOK_SLACK_MS);
        const raised = fresh.filter((c) => raisedAt(c) > raisedAfter);
        if (p.chaosMode === true && thisBrowserIsDesktop()) {
          // Only what the Live feed shows: a card hidden under the market cap line isn't on it.
          const shown = raised.filter((c) => !belowMcapLine(c, lookRef.current));
          openChaosTabs(shown, raisedAt, p, lookRef.current.quickLinks, now);
        }
        const news = raised.filter((c) => wantedBy(c, p.notifyOn));
        if (news.length === 0) return;
        claimThen(news.map(cardKey), (claimed) => {
          const mine = new Set(claimed);
          announce(
            p,
            news.filter((c) => mine.has(cardKey(c))),
          );
        });
      })
      .catch(() => undefined)
      .finally(() => {
        busy.current = false;
        if (again.current) {
          again.current = false;
          lookAt(-1);
        }
      });
  }, []);

  // A nudge means something changed after any request already in flight may have been answered:
  // never just join that one (an alert in a burst would go unannounced), ask again once it is done.
  const check = useCallback(() => {
    if (busy.current) again.current = true;
    else lookAt(-1);
  }, [lookAt]);

  const matchesLive = useNudgeStream("/matches/stream", check, listens, true);
  const callsLive = useNudgeStream("/curated/stream", check, listens, true);

  useEffect(() => {
    if (!active) {
      seen.current = null;
      return;
    }
    if (!busy.current) lookAt(0);
    let ticks = 0;
    const timer = window.setInterval(() => {
      // Streams up: they say when to look, with a slow look anyway in case one went quiet while
      // still looking open. Otherwise look on a timer.
      const streamsUp = matchesLive && callsLive;
      if (listens && (!streamsUp || ++ticks % STREAM_BACKSTOP_TICKS === 0)) check();
    }, CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [active, listens, matchesLive, callsLive, check, lookAt]);

  return null;
}

/** Pings and notifies for `toAnnounce`, the new alerts this tab claimed. */
function announce(p: AlertPrefs, toAnnounce: Card[]): void {
  if (toAnnounce.length === 0) return;
  if (p.soundEnabled) playAlertSound(p.sound, p.volume);
  // With push on, this browser gets the same alerts as push notifications (open or not).
  if (p.browserNotifications && !pushIsActive()) {
    if (toAnnounce.length > MAX_NOTIFICATIONS) {
      void showNotification(
        `${toAnnounce.length} new alerts`,
        toAnnounce.map((c) => describe(c).title).join(" · "),
        undefined,
        "ts-batch",
      );
    } else {
      for (const c of toAnnounce) {
        const d = describe(c);
        // The same gate as the card's avatar: https only, and the thumbnail, not the original.
        const icon = c.token.imageUrl?.startsWith("https://") ? tokenThumb(c.token.imageUrl, 128) : undefined;
        void showNotification(d.title, d.body, icon, cardKey(c));
      }
    }
  }
}
