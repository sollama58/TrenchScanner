import { useSyncExternalStore } from "react";
import { api, type WinTargetView } from "./api";

/**
 * The win rule the site's hit rates and call outcomes are reported on (GET /config/win-target,
 * the server's WIN_TARGET_RULE). The pages used to spell "2x within 15 minutes, before a 50% stop"
 * out in some forty places; since 2026-11-28 the server can report the fill target instead (2x on
 * a price a buyer could really get, within 30 minutes, before a 30% fall), and a page that kept the
 * old sentence beside the new numbers would be stating a rule they were not counted on.
 *
 * Until the read lands, and if it fails, the wording is the classic rule: the server's default,
 * and what every number meant before the switch existed.
 *
 * Only for surfaces whose numbers follow the reported rule (call outcomes, feed and filter
 * records, the stats popups, the card rate). The leaderboard's scores, market weather, Lighthouse
 * history and the 4x and 10x goals are always counted on the classic label and say so themselves.
 */
export const CLASSIC_WIN_TARGET: WinTargetView = {
  rule: "classic",
  windowMinutes: 15,
  multiple: 2,
  stopPct: 50,
  base: "alert",
};

const REFRESH_MS = 6 * 60 * 60_000;

let current: WinTargetView = CLASSIC_WIN_TARGET;
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function valid(v: unknown): v is WinTargetView {
  const t = v as Partial<WinTargetView> | null;
  return (
    !!t &&
    (t.rule === "classic" || t.rule === "fill30") &&
    (t.base === "alert" || t.base === "fill") &&
    [t.windowMinutes, t.multiple, t.stopPct].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n > 0,
    )
  );
}

function load(): void {
  if (inFlight || Date.now() - fetchedAt < REFRESH_MS) return;
  inFlight = api<unknown>("/config/win-target")
    .then((view) => {
      if (valid(view)) {
        current = {
          rule: view.rule,
          windowMinutes: view.windowMinutes,
          multiple: view.multiple,
          stopPct: view.stopPct,
          base: view.base,
        };
      }
      fetchedAt = Date.now();
    })
    .catch(() => {
      // Keep what we have; ask again on the next subscriber after a short wait.
      fetchedAt = Date.now() - REFRESH_MS + 60_000;
    })
    .finally(() => {
      inFlight = null;
      listeners.forEach((l) => l());
    });
}

/** The reported rule, re-rendering the caller when the server's answer lands. */
export function useWinTarget(): WinTargetView {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      load();
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}

/** The rule as last read, for text built outside a component (hover titles, share cards). */
export function winTargetNow(): WinTargetView {
  return current;
}

/** Test hook. */
export function setWinTargetForTest(view: WinTargetView | null): void {
  current = view ?? CLASSIC_WIN_TARGET;
  fetchedAt = view ? Date.now() : 0;
}

/** "15 min" / "30 min". */
export const winWindowShort = (t: WinTargetView = current): string => `${t.windowMinutes} min`;

/** "15 minutes" / "30 minutes". */
export const winWindowLong = (t: WinTargetView = current): string => `${t.windowMinutes} minutes`;

/** What the 2x and the stop are measured from: "the alert price" / "the price a buyer could get". */
export const winBase = (t: WinTargetView = current): string =>
  t.base === "fill" ? "the price a buyer could get" : "the alert price";

/**
 * The rule in a clause: "2x within 15 min of the alert, before a 50% stop", or under the fill
 * target "2x on the price a buyer could get within 30 min of the alert, before a 30% stop".
 */
export function winRuleShort(t: WinTargetView = current): string {
  const on = t.base === "fill" ? ` on ${winBase(t)}` : "";
  return `${t.multiple}x${on} within ${winWindowShort(t)} of the alert, before a ${t.stopPct}% stop`;
}

/**
 * The rule in a sentence for the explainers: "2x on the alert price within 15 minutes of the
 * alert, before a 50% drop". Under the fill target it also says what that price is.
 */
export function winRuleLong(t: WinTargetView = current): string {
  const base =
    t.base === "fill"
      ? "the price a buyer could really get (the price 16 seconds after the alert, plus 1%)"
      : "the alert price";
  return `${t.multiple}x on ${base} within ${winWindowLong(t)} of the alert, before a ${t.stopPct}% drop`;
}
