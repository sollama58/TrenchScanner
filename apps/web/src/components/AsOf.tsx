import { ago } from "../format";

/** Past this, "as of" also says how long ago, since the clock time alone is easy to misread as recent. */
const SAY_AGE_AFTER_MS = 30 * 60_000;

/**
 * "as of 14:05": when the server computed the figures (`computedAt`, SharedCache in apps/api). A
 * report can be a stale-while-revalidate copy, or the last good one kept through failed fills,
 * hours old, so the time is said rather than implied. In the reader's own clock; the date is added
 * when it isn't today.
 */
export function asOfText(computedAt: string, now = Date.now()): string {
  const at = new Date(computedAt);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const when = sameDay ? time : `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
  return now - at.getTime() > SAY_AGE_AFTER_MS ? `as of ${when}, ${ago(at, now)}` : `as of ${when}`;
}

/** asOfText as a small faint label; nothing for an older API build that sends no stamp. */
export function AsOf({ computedAt, now }: { computedAt: string | null | undefined; now?: number }) {
  if (!computedAt) return null;
  return (
    <span className="as-of faint small num" title="When these figures were computed">
      {asOfText(computedAt, now)}
    </span>
  );
}
