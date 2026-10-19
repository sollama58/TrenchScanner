import type { MarketLighthouse } from "./api";

/**
 * The Lighthouse's "By hour of the day" figures, shared by the page (MarketLighthouse.tsx) and
 * its share image (lighthouseCards.ts): the API's 24 hours laid on the reader's clock, the hours
 * worth calling out, and round axis tops.
 */

export type HourOfDayData = NonNullable<MarketLighthouse["screened"]["byHourOfDay"]>;
export type HourRow = HourOfDayData["hours"][number];

/** Hours with fewer graded tokens than this are drawn faded and never called the best: too few to read a rate from. */
export const MIN_HOUR_GRADED = 30;

/**
 * The browser's clock against UTC: the offset split into whole hours (floored) and the minutes
 * past them, so a UTC hour falls on local hour `utc + offsetHours` starting `minutes` past it
 * (00:00 UTC is 05:30 in Kolkata: column 5, labelled 05:30), and a short name for the zone
 * ("PDT", "GMT+2", or "UTC+5:30" when the short one is just "GMT").
 */
export function localClock(now = new Date()) {
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetHours = Math.floor(offsetMinutes / 60);
  const minutes = offsetMinutes - offsetHours * 60;
  let name: string;
  try {
    name =
      new Intl.DateTimeFormat([], { timeZoneName: "short" })
        .formatToParts(now)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    name = "";
  }
  if (!name || name === "GMT" || name === "UTC") {
    const abs = Math.abs(offsetMinutes);
    const mm = abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : "";
    name = offsetMinutes === 0 ? "UTC" : `UTC${offsetMinutes > 0 ? "+" : "−"}${Math.floor(abs / 60)}${mm}`;
  }
  return { offsetHours, minutes, name };
}

export type Clock = ReturnType<typeof localClock>;

/**
 * The API's hours on the reader's clock: column i is local hour i. The API sums per hour in the
 * browser's zone (the `tz` it was sent), so those hours start on the hour. An older API, or a
 * browser that can't name its zone, sends UTC hours, shifted here by today's offset, and those
 * start `minutes` past the hour (05:30 in Kolkata).
 */
export function localHours(h: HourOfDayData, clock: Clock): { hours: HourRow[]; minutes: number } {
  const utc = !h.timeZone || h.timeZone === "UTC";
  const shift = utc ? clock.offsetHours : 0;
  const hours = Array.from({ length: 24 }, (_, local) => {
    const from = (((local - shift) % 24) + 24) % 24;
    return { ...(h.hours[from] ?? h.hours[0]!), hour: local };
  });
  return { hours, minutes: utc ? clock.minutes : 0 };
}

const wrap24 = (h: number) => ((h % 24) + 24) % 24;

/**
 * An hour on the reader's clock, in their locale's style: "3 AM" or "15" (en-GB writes "15"),
 * or "05:30" when the hours start part-way through.
 */
export function clockHour(h: number, minutes = 0, locale?: string): string {
  const hh = wrap24(h);
  if (minutes) return `${String(hh).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  try {
    return new Date(2000, 0, 1, hh).toLocaleTimeString(locale ?? [], { hour: "numeric" });
  } catch {
    return `${hh}h`;
  }
}

/** "1–2 AM", "23–00" or "05:30–06:30": one hour's span, its shared AM/PM written once. */
export function hourSpan(h: number, minutes = 0, locale?: string): string {
  const a = clockHour(h, minutes, locale);
  const b = clockHour(h + 1, minutes, locale);
  const [, aNum, aSuf] = /^(\d+)\s*(\D*)$/.exec(a) ?? [];
  const [, bNum, bSuf] = /^(\d+)\s*(\D*)$/.exec(b) ?? [];
  if (aNum && bNum && aSuf && aSuf === bSuf) return `${aNum}–${bNum} ${aSuf}`;
  return `${a}–${b}`;
}

/** The whole day's rates, weighted by what each hour graded, and the hours worth calling out. */
export function hourStats(hours: HourRow[]) {
  const calls = hours.reduce((s, x) => s + x.calls, 0);
  const graded = hours.reduce((s, x) => s + x.graded, 0);
  const hit = hours.reduce((s, x) => s + (x.hit2xPct ?? 0) * x.graded, 0);
  const retN = hours.reduce((s, x) => s + (x.avgReturnPct === null ? 0 : x.returnGraded), 0);
  const ret = hours.reduce((s, x) => s + (x.avgReturnPct ?? 0) * x.returnGraded, 0);
  const solid = hours.filter((x) => x.graded >= MIN_HOUR_GRADED);
  const pick = (rows: HourRow[], by: (x: HourRow) => number | null) =>
    rows.reduce<HourRow | null>((b, x) => {
      const v = by(x);
      return v !== null && (b === null || v > (by(b) ?? -Infinity)) ? x : b;
    }, null);
  return {
    calls,
    graded,
    hit2xPct: graded > 0 ? hit / graded : null,
    avgReturnPct: retN > 0 ? ret / retN : null,
    best2x: pick(solid, (x) => x.hit2xPct),
    bestReturn: pick(solid, (x) => x.avgReturnPct),
    busiest: pick(hours, (x) => (x.calls > 0 ? x.calls : null)),
  };
}

/** A round axis top at or above `v`: 1, 2, 2.5 or 5 times a power of ten (915 → 1,000, 26 → 30). */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
}
