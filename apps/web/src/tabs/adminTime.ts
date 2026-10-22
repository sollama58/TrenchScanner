/** Admin timestamps are shown in Eastern Time, with a short zone label. */

export const ADMIN_TIME_ZONE = "America/New_York";
export const ADMIN_TIME_LABEL = "ET";

function asDate(input: string | Date | null | undefined): Date | null {
  if (input == null || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Oct 22, 4:13 PM ET". Null when the input is not a time. */
export function formatAdminTime(input: string | Date | null | undefined): string | null {
  const d = asDate(input);
  if (!d) return null;
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: ADMIN_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  return `${text} ${ADMIN_TIME_LABEL}`;
}

/** A duration an admin can scan: 45s, 12m, 1.5h. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "–";
  if (ms >= 3_600_000) {
    const hours = ms / 3_600_000;
    const text = hours >= 10 ? hours.toFixed(0) : hours.toFixed(1).replace(/\.0$/, "");
    return `${text}h`;
  }
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** "Oct 22, 2026 ET". */
export function formatAdminDay(input: string | Date | null | undefined): string | null {
  const d = asDate(input);
  if (!d) return null;
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: ADMIN_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
  return `${text} ${ADMIN_TIME_LABEL}`;
}
