import { prisma, Prisma, type LaunchBuyersReading } from "@trenchscanner/core";
import type { LaunchReadStore, StoredLaunchRead } from "./launchSnipers.js";

/**
 * Launch reads kept in the LaunchRead table (launchSnipers.ts), so a restart or a deploy loads the
 * band's first buyers and block zero back instead of paying 10-30 credits a coin to read them
 * again (Helius audit 2026-10-22, H-3). One row per mint, replaced by a later read; the cleanup
 * job drops rows past LAUNCH_READ_RETENTION_DAYS (cleanupJob.ts), but keeps a complete read while
 * its coin is still tracked.
 */
export const prismaLaunchReadStore: LaunchReadStore = {
  async load(mints) {
    const out = new Map<string, StoredLaunchRead>();
    if (mints.length === 0) return out;
    const rows = await prisma.launchRead.findMany({ where: { mintAddress: { in: [...mints] } } });
    for (const row of rows) {
      const reading = revive(row.reading);
      if (reading)
        out.set(row.mintAddress, { reading, complete: row.complete, readAt: row.checkedAt.getTime() });
    }
    return out;
  },
  async save(reads) {
    if (reads.size === 0) return;
    // One statement for the cycle's reads (up to the per-cycle lookup budgets), not one upsert each.
    const rows = [...reads].map(
      ([mintAddress, r]) =>
        Prisma.sql`(${mintAddress}, ${JSON.stringify(r.reading)}::jsonb, ${r.complete}, ${new Date(r.readAt)})`,
    );
    await prisma.$executeRaw`
      INSERT INTO "LaunchRead" ("mintAddress", "reading", "complete", "checkedAt")
      VALUES ${Prisma.join(rows)}
      ON CONFLICT ("mintAddress") DO UPDATE SET
        "reading" = EXCLUDED."reading",
        "complete" = EXCLUDED."complete",
        "checkedAt" = EXCLUDED."checkedAt"`;
  },
};

/** A saved reading back into shape: launchAt was written as an ISO string. Null for a row that isn't one. */
export function revive(json: unknown): LaunchBuyersReading | null {
  if (!json || typeof json !== "object") return null;
  const r = json as Omit<LaunchBuyersReading, "launchAt"> & { launchAt?: string | null };
  if (!Array.isArray(r.buyers) || typeof r.supply !== "number") return null;
  return { ...r, launchAt: r.launchAt ? new Date(r.launchAt) : null };
}
