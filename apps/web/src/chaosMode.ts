import { useSyncExternalStore } from "react";
import type { AlertPrefs, Card, ChaosSite, QuickLink } from "./api";
import { QUICK_LINK_SITES, pumpFunHref } from "./appearance";

/**
 * Chaos Mode (user ask 2026-10-17): every new alert in the Live feed opens in a new tab on the
 * trading site the user picked, up to their per-minute cap. Desktop browsers only, even when the
 * account has it on, so a phone signed in to the same wallet never starts throwing tabs.
 *
 * Browsers block window.open that no click started, so the tabs only open once the user allows
 * pop-ups for this site; a blocked open is remembered here so Settings can say what to do.
 */

export const CHAOS_SITE_OPTIONS: { id: ChaosSite; label: string; href: (mint: string) => string }[] = [
  ...QUICK_LINK_SITES,
  { id: "pumpfun", label: "Pump.fun", href: pumpFunHref },
];

/** The API's bounds and default (apps/api/src/alertPrefs.ts). */
export const CHAOS_PER_MINUTE = { min: 1, max: 60, default: 10 } as const;

/** Alerts raised longer ago than this aren't opened: a laptop waking from sleep shouldn't open a backlog. */
export const CHAOS_FRESH_MS = 5 * 60_000;
const WINDOW_MS = 60_000;
const OPENED_KEY = "ts-chaos-opened-v1";
const CLAIMED_KEY = "ts-chaos-claimed-v1";
const CLAIMED_KEEP = 200;
/** A Solana mint address: a tab no click started never opens a path built from anything else. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The site to open: the user's pick, else the first of their cards' quick links, else Padre's Terminal. */
export function chaosSite(prefs: Pick<AlertPrefs, "chaosSite">, quickLinks: QuickLink[]): ChaosSite {
  return prefs.chaosSite ?? quickLinks[0] ?? "terminal";
}

export function chaosPerMinute(prefs: Pick<AlertPrefs, "chaosPerMinute">): number {
  const n = prefs.chaosPerMinute;
  return typeof n === "number" && Number.isFinite(n)
    ? Math.min(CHAOS_PER_MINUTE.max, Math.max(CHAOS_PER_MINUTE.min, Math.round(n)))
    : CHAOS_PER_MINUTE.default;
}

type BrowserTraits = {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  /** navigator.userAgentData.mobile, where the browser has it. */
  mobile?: boolean;
  /** Whether the primary pointer is a mouse or trackpad. */
  finePointer: boolean;
};

/** Whether this looks like a desktop browser: no phone or tablet signal, and a mouse or trackpad. */
export function isDesktopBrowser(t: BrowserTraits): boolean {
  if (t.mobile === true) return false;
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini/i.test(t.userAgent)) return false;
  // iPadOS asks for desktop sites with a Mac user agent; its touch points give it away.
  if (t.platform === "MacIntel" && (t.maxTouchPoints ?? 0) > 1) return false;
  return t.finePointer;
}

export function thisBrowserIsDesktop(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return isDesktopBrowser({
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    mobile: nav.userAgentData?.mobile,
    finePointer: window.matchMedia?.("(pointer: fine)").matches ?? false,
  });
}

/**
 * How many of `wanted` tabs may open now under `cap` a minute, given the times of the tabs opened
 * so far (`opened`, any order). Returns that count and the times still inside the last minute.
 */
export function chaosSlots(opened: number[], now: number, cap: number, wanted: number) {
  const recent = opened.filter((t) => t > now - WINDOW_MS && t <= now);
  return { allowed: Math.max(0, Math.min(wanted, cap - recent.length)), recent };
}

/** The cards to open for these new alerts: fresh enough, newest `allowed`, oldest first so the newest ends up in front. */
export function chaosPicks<C extends { raisedAt: number }>(news: C[], now: number, allowed: number): C[] {
  return news
    .filter((c) => c.raisedAt > now - CHAOS_FRESH_MS)
    .sort((a, b) => b.raisedAt - a.raisedAt)
    .slice(0, allowed)
    .reverse();
}

// ---- What happened, for the Settings panel ----

export type ChaosStatus = {
  /** Set when the browser refused the last tab: pop-ups aren't allowed for this site. */
  blockedAt: number | null;
  opened: number;
  /** New alerts left unopened because the minute's cap was used up. */
  skipped: number;
};

let status: ChaosStatus = { blockedAt: null, opened: 0, skipped: 0 };
const listeners = new Set<() => void>();

function setStatus(change: Partial<ChaosStatus>) {
  status = { ...status, ...change };
  for (const l of listeners) l();
}

export function useChaosStatus(): ChaosStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

function readList<T>(key: string): T[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: unknown[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Private windows and full storage: this tab still opens, it just can't share the count.
  }
}

/** Opens a tab without handing the site a handle back to this page. Null when the browser blocked it. */
function openTab(url: string): Window | null {
  const w = window.open(url, "_blank");
  if (w) {
    try {
      w.opener = null;
    } catch {
      // Already cross-origin: nothing to cut.
    }
  }
  return w;
}

type ChaosArgs = Parameters<typeof openChaosTabsNow>;

/**
 * Opens new alerts' tokens in tabs, within the per-minute cap. Every TrenchScanner tab in this
 * browser runs the notifier, so alerts are claimed and the cap counted in localStorage, shared by
 * them all: two open tabs open each alert once, and ten a minute is ten in total. The claim and the
 * count run under a cross-tab lock where the browser has one, so two tabs nudged by the same alert
 * can't both read the list before either writes it.
 */
export function openChaosTabs(...args: ChaosArgs): void {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks) void locks.request("ts-chaos", () => openChaosTabsNow(...args));
  else openChaosTabsNow(...args);
}

const claimKey = (c: Card) => `${c.kind}:${c.id}`;

/** openChaosTabs without the lock: claims, counts and opens in one go. */
export function openChaosTabsNow(
  cards: Card[],
  raisedAt: (c: Card) => number,
  prefs: Pick<AlertPrefs, "chaosSite" | "chaosPerMinute">,
  quickLinks: QuickLink[],
  now = Date.now(),
): void {
  const claimed = new Set(readList<string>(CLAIMED_KEY));
  const mine = cards.filter((c) => !claimed.has(claimKey(c)) && MINT_RE.test(c.token.mintAddress));
  if (mine.length === 0) return;
  writeList(CLAIMED_KEY, [...claimed, ...mine.map(claimKey)].slice(-CLAIMED_KEEP));

  const site =
    CHAOS_SITE_OPTIONS.find((s) => s.id === chaosSite(prefs, quickLinks)) ?? CHAOS_SITE_OPTIONS[0]!;
  const fresh = mine.map((card) => ({ card, raisedAt: raisedAt(card) }));
  const freshCount = fresh.filter((c) => c.raisedAt > now - CHAOS_FRESH_MS).length;
  const { allowed, recent } = chaosSlots(
    readList<number>(OPENED_KEY),
    now,
    chaosPerMinute(prefs),
    freshCount,
  );
  const picks = chaosPicks(fresh, now, allowed);
  const stamps = [...recent];
  let opened = 0;
  for (const { card } of picks) {
    if (!openTab(site.href(card.token.mintAddress))) {
      // Blocked: the rest would be too. Settings says how to allow pop-ups. Hand the unopened
      // picks back so a tab that is allowed pop-ups can still open them while they're fresh.
      setStatus({ blockedAt: now });
      const unopened = new Set(picks.slice(opened).map(({ card: c }) => claimKey(c)));
      writeList(
        CLAIMED_KEY,
        readList<string>(CLAIMED_KEY).filter((k) => !unopened.has(k)),
      );
      break;
    }
    stamps.push(now);
    opened += 1;
  }
  writeList(OPENED_KEY, stamps);
  setStatus({
    opened: status.opened + opened,
    skipped: status.skipped + (freshCount - allowed),
    ...(opened > 0 ? { blockedAt: null } : {}),
  });
}

/**
 * The Settings panel's check, run from a click: the first tab rides the click, the second has no
 * click left to ride (a click allows one pop-up), so it only opens when pop-ups are allowed for
 * this site - as an alert's tab, which no click starts, needs. Both close at once.
 */
export function checkPopups(): "allowed" | "blocked" {
  const first = window.open("about:blank", "_blank");
  const second = window.open("about:blank", "_blank");
  first?.close();
  second?.close();
  const ok = second !== null;
  setStatus({ blockedAt: ok ? null : Date.now() });
  return ok ? "allowed" : "blocked";
}
