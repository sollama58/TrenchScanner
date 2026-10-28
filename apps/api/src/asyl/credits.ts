import { prisma, type Env } from "@trenchscanner/core";

/**
 * Asyl's chain-read allowance (user decision 2026-10-24: capped reads, 3,000 Helius credits per Pro
 * user per UTC day and 150,000 for everyone together). A read checks what is left against its
 * worst case before it starts, then records what the meter says it took (tallyHeliusCredits), so
 * a read that hits caches costs the reader nothing. AsylCreditUse holds the totals: they survive a
 * deploy, and a second API instance reads the same rows.
 */

/** The UTC date as "YYYY-MM-DD", the key of a day's row. */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Rows kept, in days: the totals are only ever read for today. */
const KEEP_DAYS = 7;

export interface Allowance {
  /** Chain reads are on at all (both caps above zero). */
  enabled: boolean;
  used: number;
  cap: number;
  /** What everyone together has used today, and the site-wide cap. */
  globalUsed: number;
  globalCap: number;
  /** What this user may still spend today: the smaller of their own and the site's room. */
  left: number;
  /** When the day ends (ISO), for "resets in". */
  resetsAt: string;
}

/** The allowance as the numbers stand: pure, for tests. */
export function allowanceOf(
  caps: { user: number; global: number },
  used: number,
  globalUsed: number,
  now = Date.now(),
): Allowance {
  const enabled = caps.user > 0 && caps.global > 0;
  const left = enabled ? Math.max(0, Math.min(caps.user - used, caps.global - globalUsed)) : 0;
  const end = new Date(now);
  end.setUTCHours(24, 0, 0, 0);
  return {
    enabled,
    used,
    cap: caps.user,
    globalUsed,
    globalCap: caps.global,
    left,
    resetsAt: end.toISOString(),
  };
}

export function capsOf(env: Pick<Env, "ASYL_USER_DAILY_CREDITS" | "ASYL_DAILY_CREDITS">) {
  return { user: env.ASYL_USER_DAILY_CREDITS, global: env.ASYL_DAILY_CREDITS };
}

export async function readAllowance(
  env: Pick<Env, "ASYL_USER_DAILY_CREDITS" | "ASYL_DAILY_CREDITS">,
  userId: string,
  now = Date.now(),
): Promise<Allowance> {
  const day = utcDay(now);
  const [mine, all] = await Promise.all([
    prisma.asylCreditUse.findUnique({ where: { userId_day: { userId, day } }, select: { credits: true } }),
    prisma.asylCreditUse.aggregate({ where: { day }, _sum: { credits: true } }),
  ]);
  return allowanceOf(capsOf(env), mine?.credits ?? 0, all._sum.credits ?? 0, now);
}

let lastSweepDay = "";

/** Adds a read's credits to the user's day. Also clears rows past KEEP_DAYS, once a day. */
export async function recordSpend(userId: string, credits: number, now = Date.now()): Promise<void> {
  const day = utcDay(now);
  await prisma.asylCreditUse.upsert({
    where: { userId_day: { userId, day } },
    create: { userId, day, credits, reads: 1 },
    update: { credits: { increment: credits }, reads: { increment: 1 } },
  });
  if (lastSweepDay !== day) {
    lastSweepDay = day;
    const cutoff = utcDay(now - KEEP_DAYS * 86_400_000);
    await prisma.asylCreditUse.deleteMany({ where: { day: { lt: cutoff } } }).catch(() => undefined);
    await prisma.asylFlowRead
      .deleteMany({ where: { readAt: { lt: new Date(now - KEEP_DAYS * 86_400_000) } } })
      .catch(() => undefined);
    await prisma.asylQuotaUse.deleteMany({ where: { day: { lt: cutoff } } }).catch(() => undefined);
  }
}

/**
 * Takes `n` of today's `cap` under `key` in AsylQuotaUse (another vendor's metered plan, such as
 * Solana Tracker's top-traders reads), or nothing when that would pass the cap. One statement, so
 * two readers at once, or two API instances, can't both take the last of it. True when taken.
 */
export async function takeQuota(key: string, n: number, cap: number, now = Date.now()): Promise<boolean> {
  if (n > cap) return false;
  const rows = await prisma.$queryRaw<{ used: number }[]>`
    INSERT INTO "AsylQuotaUse" ("key", "day", "used", "updatedAt")
    VALUES (${key}, ${utcDay(now)}, ${n}, NOW())
    ON CONFLICT ("key", "day") DO UPDATE
       SET "used" = "AsylQuotaUse"."used" + EXCLUDED."used", "updatedAt" = NOW()
     WHERE "AsylQuotaUse"."used" + EXCLUDED."used" <= ${cap}
    RETURNING "used"`;
  return rows.length > 0;
}

/** Hands back `n` taken by takeQuota today and not spent after all. */
export async function giveBackQuota(key: string, n: number, now = Date.now()): Promise<void> {
  if (n <= 0) return;
  await prisma.$executeRaw`
    UPDATE "AsylQuotaUse" SET "used" = GREATEST(0, "used" - ${n}), "updatedAt" = NOW()
     WHERE "key" = ${key} AND "day" = ${utcDay(now)}`;
}

/** What `key` has used today in AsylQuotaUse. */
export async function quotaUsed(key: string, now = Date.now()): Promise<number> {
  const row = await prisma.asylQuotaUse.findUnique({
    where: { key_day: { key, day: utcDay(now) } },
    select: { used: true },
  });
  return row?.used ?? 0;
}

/**
 * Worst cases of the chain reads running now in this process, held against the site's cap until
 * each read has recorded what it took (full audit 2026-10-27, TR-8). Without it, readers who check
 * at the same moment each see the same room and together overshoot by (readers x worst case).
 * Per process: the API runs as one instance (render.yaml). A second instance would need this, and
 * oneAtATime below, moved into the database (an advisory lock or a reservation row).
 */
let heldSite = 0;

/** Credits held by reads in flight in this process. */
export function siteHeld(): number {
  return heldSite;
}

/** Holds `worst` against the site's cap while `fn` runs. Take it synchronously after the check. */
export async function holdingSite<T>(worst: number, fn: () => Promise<T>): Promise<T> {
  heldSite += worst;
  try {
    return await fn();
  } finally {
    heldSite -= worst;
  }
}

/** One chain read at a time per user: a double click never pays twice. Per process (see heldSite). */
const running = new Set<string>();

export async function oneAtATime<T>(userId: string, fn: () => Promise<T>): Promise<T | "busy"> {
  if (running.has(userId)) return "busy";
  running.add(userId);
  try {
    return await fn();
  } finally {
    running.delete(userId);
  }
}
