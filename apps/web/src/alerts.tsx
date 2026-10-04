import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { put, type AlertPrefs, type Card, type MatchPage, type Settings } from "./api";
import { cachedGet, peek } from "./cache";
import { useNudgeStream } from "./hooks";
import { playAlertSound, unlockAudio } from "./alertSounds";
import { usd } from "./format";

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
  loading = cachedGet<Settings>(SETTINGS_PATH, force ? -1 : 0)
    .then((s) => {
      settings = s;
      emit();
    })
    .finally(() => {
      loading = null;
    });
  return loading;
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

function showNotification(title: string, body: string, icon: string | undefined, tag: string): boolean {
  if (notificationState() !== "granted") return false;
  try {
    const n = new Notification(title, { body, icon, tag });
    n.onclick = () => {
      window.focus();
      if (window.location.hash !== "") window.location.hash = "";
      n.close();
    };
    return true;
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
    return false;
  }
}

/** Plays the user's sound now (the Settings tab's preview and test button). */
export function previewAlert(prefs: AlertPrefs, withNotification: boolean): void {
  unlockAudio();
  playAlertSound(prefs.sound, prefs.volume);
  if (withNotification) {
    showNotification("TrenchScanner test alert", "This is how a new alert will look.", undefined, "ts-test");
  }
}

// ---- The notifier ----

const FEED_PATH = "/matches?page=1&includeCurated=saved";
/** Cards older than this when first seen are not news (a settings change brought them in). */
const FRESH_MS = 15 * 60_000;
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
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const notifies = prefs !== null && prefs.browserNotifications && notificationState() === "granted";
  const active = prefs !== null && (prefs.soundEnabled || notifies);
  const wantsMatches = active && prefs!.notifyOn.filterMatches;
  const wantsCalls = active && prefs!.notifyOn.modelCalls;

  // Browsers only allow sound after an interaction with the page: unlock on the first one.
  useEffect(() => {
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
        if (seen.current === null) {
          // The first look only learns what is already there.
          seen.current = new Set(cards.map(cardKey));
          return;
        }
        const p = prefsRef.current;
        const fresh = cards.filter((c) => !seen.current!.has(cardKey(c)));
        for (const c of fresh) seen.current.add(cardKey(c));
        if (!p) return;
        const now = Date.now();
        const news = fresh.filter(
          (c) =>
            now - new Date(c.matchedAt).getTime() < FRESH_MS &&
            (c.kind === "curated" ? p.notifyOn.modelCalls : p.notifyOn.filterMatches),
        );
        const mine = new Set(claim(news.map(cardKey)));
        const toAnnounce = news.filter((c) => mine.has(cardKey(c)));
        if (toAnnounce.length === 0) return;
        if (p.soundEnabled) playAlertSound(p.sound, p.volume);
        if (p.browserNotifications) {
          if (toAnnounce.length > MAX_NOTIFICATIONS) {
            showNotification(
              `${toAnnounce.length} new alerts`,
              toAnnounce.map((c) => describe(c).title).join(" · "),
              undefined,
              "ts-batch",
            );
          } else {
            for (const c of toAnnounce) {
              const d = describe(c);
              showNotification(d.title, d.body, c.token.imageUrl ?? undefined, cardKey(c));
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
