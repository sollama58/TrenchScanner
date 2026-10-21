import { useSyncExternalStore } from "react";

/** The one clock every stamp reads, so two stamps of the same moment never differ by a second. */
let clock = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer = 0;

function syncClock(): void {
  const next = Date.now();
  if (next === clock) return;
  clock = next;
  for (const l of clockListeners) l();
}

/** A hidden tab's timer is paused or skipped. Catch up the moment it is visible again, or a
 * stamp keeps the time from when the tab was left and an old holder list reads as just updated
 * (user ask 2026-10-21). */
function onClockVisible(): void {
  if (document.visibilityState === "visible") syncClock();
}

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockListeners.size === 1) {
    clock = Date.now();
    // Keep ticking while hidden too. Skipping those ticks left `clock` at the last visible
    // second, so "12s ago" and the countdown stayed there until the next tick after returning.
    clockTimer = window.setInterval(syncClock, 1_000);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onClockVisible);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0) {
      window.clearInterval(clockTimer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onClockVisible);
    }
  };
}

/**
 * The clock, ticking each second while the page is visible: for the token view's "12s ago" and
 * "Next update in 0:48" (user ask 2026-10-19), which the view's own 15-second tick would jump.
 * Every stamp shares the one tick, so the header, the map's badge and the lists agree.
 */
export function useSecondTick(): number {
  const read = () => clock;
  // The same clock on a server render (the tests' renderToStaticMarkup).
  return useSyncExternalStore(subscribeClock, read, read);
}

/** How long ago, to the second: "12s ago", "3m 05s ago", "2h 04m ago", "3d ago". */
export function secondsAgo(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1_000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Time left as a countdown: "0:48", "12:05", "1:02:05"; "0:00" once it has passed. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1_000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A clock time to the second, in the reader's own clock: "11:08:23 AM". */
export function hms(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

/**
 * "Next update in 0:48", counting to `next`, the view's read that will show it; "Updating…" while
 * that read lands. `late`: a read since the update was due found none, so the count is to the
 * next look for it: "Checking again in 0:12".
 */
export function nextUpdateText(next: number, now: number, late = false): string {
  if (next - now < 1_000) return "Updating…";
  return `${late ? "Checking again" : "Next update"} in ${countdown(next - now)}`;
}

/**
 * When a poll on a fixed beat reads next: the first beat at or after `now`, counted from `from`
 * (when its timer started, hooks.ts usePolling `schedule`).
 */
export function nextBeat(schedule: { from: number; every: number }, now: number): number {
  const { from, every } = schedule;
  return now <= from ? from : from + Math.ceil((now - from) / every) * every;
}

/** "12s ago", ticking each second. */
export function SecondsAgo({ at }: { at: number }) {
  const now = useSecondTick();
  return <>{secondsAgo(at, now)}</>;
}

/**
 * A section's freshness beside its count: "12s ago · Next update in 0:48" (user ask 2026-10-19).
 * `next` is when the view reads again (the update shows then): a time, or a poll's beat; null
 * when no update is coming (the coin is no longer scanned), so only the age shows. `late`: see
 * nextUpdateText. `live`: shares also move with each trade. That does not replace the age or the
 * countdown: a trade is not a new holder read (user ask 2026-10-21).
 */
export function LiveStamp({
  last,
  next,
  late = false,
  title,
  live = false,
}: {
  last: number;
  next: number | { from: number; every: number } | null;
  late?: boolean;
  title?: string;
  /** Shares move with each live trade between reads (user ask 2026-10-19): "Live" in place of the stamp. */
  live?: boolean;
}) {
  const now = useSecondTick();
  const at = next === null ? null : typeof next === "number" ? next : nextBeat(next, now);
  return (
    <span
      className="tm-live-stamp small muted num"
      title={
        (title ?? `Updated ${hms(last)}${at === null ? "" : `; next read ${hms(at)}`}`) +
        (live ? ". Shares move with each trade until then; links and tags come with each read." : "")
      }
    >
      {live ? "Live · " : null}
      {secondsAgo(last, now)}
      {at !== null && <> · {nextUpdateText(at, now, late)}</>}
    </span>
  );
}
