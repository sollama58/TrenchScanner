import { z } from "zod";
import { prisma } from "@trenchscanner/core";

/**
 * The reader's IANA zone as the browser names it (Intl's resolvedOptions().timeZone), for reports
 * that bucket by day or by hour of day. Canonicalized, so "europe/berlin" and "Europe/Berlin"
 * share one cache. Absent means UTC, and so does a zone this server's ICU doesn't know
 * ("Etc/Unknown", which Chrome reports when it can't tell, or a zone newer than our tzdata): the
 * answer says UTC rather than failing over a hint.
 */
export const readerZoneSchema = z
  .string()
  .max(64)
  .transform((tz) => canonicalTimeZone(tz) ?? "UTC")
  .default("UTC");

export function canonicalTimeZone(tz: string): string | null {
  try {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
    // Named zones only. ICU also accepts bare offsets ("+05:30", "-0800": ~2,800 distinct values),
    // and each one would get a cache of its own; browsers report a named zone anyway.
    return /^[+-]/.test(zone) ? null : zone;
  } catch {
    return null;
  }
}

let postgresZones: Promise<Set<string>> | undefined;

/**
 * `zone` if Postgres knows it by that name, else UTC: for SQL that buckets with AT TIME ZONE, which
 * fails the whole query on a name it doesn't know. ICU and Postgres's tzdata mostly agree, but
 * their aliases differ. The list is read once per process; a failed read is retried next call.
 */
export async function postgresTimeZone(zone: string): Promise<string> {
  if (zone === "UTC") return zone;
  postgresZones ??= prisma.$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names`.then(
    (rows) => new Set(rows.map((r) => r.name)),
  );
  try {
    return (await postgresZones).has(zone) ? zone : "UTC";
  } catch {
    postgresZones = undefined;
    return "UTC";
  }
}
