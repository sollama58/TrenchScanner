import { useEffect, useState } from "react";

/**
 * The clock, ticking each second while the page is visible: for the token view's "12s ago" and
 * "Next update in 0:48" (user ask 2026-10-19), which the view's own 15-second tick would jump.
 */
export function useSecondTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 1_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
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

/** "Next update in 0:48", or "Next update due now" once the countdown runs out. */
export function nextUpdateText(next: number, now: number): string {
  return next - now >= 1_000 ? `Next update in ${countdown(next - now)}` : "Next update due now";
}

/** "12s ago", ticking each second. */
export function SecondsAgo({ at }: { at: number }) {
  const now = useSecondTick();
  return <>{secondsAgo(at, now)}</>;
}

/**
 * A section's freshness beside its count: "12s ago · Next update in 0:48" (user ask 2026-10-19).
 * `next` null: no update is coming (the coin is no longer scanned), so only the age shows.
 */
export function LiveStamp({ last, next, title }: { last: number; next: number | null; title?: string }) {
  const now = useSecondTick();
  return (
    <span
      className="tm-live-stamp small muted num"
      title={title ?? `Updated ${hms(last)}${next === null ? "" : `; next due ${hms(next)}`}`}
    >
      {secondsAgo(last, now)}
      {next !== null && <> · {nextUpdateText(next, now)}</>}
    </span>
  );
}
