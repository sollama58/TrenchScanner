import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { put, type AlertPrefs, type Card, type MatchPage, type Settings } from "./api";
import { cachedGet, peek } from "./cache";
import { useNudgeStream } from "./hooks";
import { playAlertSound, unlockAudio } from "./alertSounds";
import { tokenThumb, usd } from "./format";
import { adoptAppearance, appearanceVersion } from "./appearance";

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
  loading = cachedGet<Settings>(SETTINGS_PATH, force ? -1 : 0)
    .then((s) => {
      settings = s;
      // The feed's look rides along; a change made on this device since the request wins.
      adoptAppearance(s.appearance, lookVersion);
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

export function useSettings(): Settings | null {
  const s = useSyncExternalStore(subscribe, () => settings);
  useEffect(() => {
    void loadSettings().catch(() => undefined);
  }, []);
  return s;
}

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
  try {
    const res = await put<{ alerts: AlertPrefs }>(`${SETTINGS_PATH}/alerts`, change);
    if (settings) {
      settings = { ...settings, alerts: res.alerts };
      emit();
    }
  } catch (e) {
    settings = before;
    emit();
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
/** More new alerts than this at once become one summary notification. */
const MAX_NOTIFICATIONS = 3;
const NOTIFIED_KEY = "ts-notified-v1";
const NOTIFIED_KEEP = 200;

const cardKey = (c: Card) => `${c.kind}:${c.id}`;

/**
 * Claims `keys` for this browser tab, so two open tabs don't both ping for the same alert.
 * Returns the keys no other tab has claimed.
 */
function claim(keys: string[]): string[] {
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

function describe(card: Card): { title: string; body: string } {
  const t = card.token;
  const name = t.symbol ? `$${t.symbol}` : (t.name ?? `${t.mintAddress.slice(0, 4)}…`);
  const mcap = card.currentMarketCapUsd ?? card.snapshot?.marketCapUsd ?? null;
  const at = mcap !== null ? ` at ${usd(mcap)} mcap` : "";
  if (card.kind === "curated") {
    const model = card.curated?.modelName ?? "A model";
    return { title: `${name}: ${model} call`, body: `${model} called ${name}${at}.` };
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

  const notifies = prefs !== null && prefs.browserNotifications && notificationState() === "granted";
  const active = prefs !== null && (prefs.soundEnabled || notifies);
  const wantsMatches = active && prefs!.notifyOn.filterMatches;
  const wantsCalls = active && prefs!.notifyOn.modelCalls;

  // Browsers only allow sound after an interaction with the page: unlock on the first one.
  useEffect(() => {
    prepareNotifications();
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const check = useCallback(() => {
    cachedGet<MatchPage>(FEED_PATH, 0)
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
        const news = fresh.filter(
          (c) =>
            new Date(c.matchedAt).getTime() > raisedAfter &&
            (c.kind === "curated" ? p.notifyOn.modelCalls : p.notifyOn.filterMatches),
        );
        const mine = new Set(claim(news.map(cardKey)));
        const toAnnounce = news.filter((c) => mine.has(cardKey(c)));
        if (toAnnounce.length === 0) return;
        if (p.soundEnabled) playAlertSound(p.sound, p.volume);
        if (p.browserNotifications) {
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
              const icon = c.token.imageUrl?.startsWith("https://")
                ? tokenThumb(c.token.imageUrl, 128)
                : undefined;
              void showNotification(d.title, d.body, icon, cardKey(c));
            }
          }
        }
      })
      .catch(() => undefined);
  }, []);

  const matchesLive = useNudgeStream("/matches/stream", check, wantsMatches, true);
  const callsLive = useNudgeStream("/curated/stream", check, wantsCalls, true);

  useEffect(() => {
    if (!active) {
      seen.current = null;
      return;
    }
    check();
    const timer = window.setInterval(() => {
      // Streams up: they say when to look. Otherwise look on a timer.
      if (!((!wantsMatches || matchesLive) && (!wantsCalls || callsLive))) check();
    }, CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [active, wantsMatches, wantsCalls, matchesLive, callsLive, check]);

  return null;
}
