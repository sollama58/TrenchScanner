import { z } from "zod";
import { prisma, createLogger, Prisma, type RugCheckClient, type RugCheckProfile } from "@trenchscanner/core";

const logger = createLogger("rugcheck-cache");

/**
 * Shape validation for what comes back out of the Json column. A cached row is data this process
 * wrote earlier, but a deploy can change the profile shape underneath rows written by the previous
 * version - validating on read turns that into an ordinary cache miss instead of a crash or, worse,
 * a half-populated profile silently reaching the rug screen.
 */
const cachedProfileSchema = z
  .object({
    mintAddress: z.string(),
    holderCount: z.number().optional(),
    top10HolderPct: z.number().optional(),
    devWalletPct: z.number().optional(),
    mintAuthorityActive: z.boolean(),
    freezeAuthorityActive: z.boolean(),
    lpBurned: z.boolean(),
    riskScore: z.number(),
    riskFlags: z.array(z.string()),
    top10HolderAddresses: z.array(z.string()).optional(),
    // passthrough, not strip: zod drops unknown keys by default, so a field added to toProfile()
    // would vanish from every cached profile while fresh ones still carried it - a difference that
    // shows up as behaviour changing depending on cache state, which is close to unfindable.
    // Rejecting outright would be worse: the row would be refetched and rewritten in the same shape
    // forever, never satisfying the schema.
  })
  .passthrough();

export interface RugProfileResolution {
  profiles: Map<string, RugCheckProfile>;
  /** Mints RugCheck definitively has no report for - distinct from ones whose lookup failed. */
  absent: Set<string>;
  stats: { requested: number; cached: number; fetched: number; failed: number };
}

/**
 * Resolves RugCheck profiles for a set of mints, going to the network only for mints whose cached
 * answer is missing or older than `ttlMinutes`.
 *
 * This is what lets the scan cadence and the RugCheck request rate be set independently. RugCheck
 * was the only upstream with no cache: one request per in-band candidate per cycle, so shortening
 * SCAN_INTERVAL_MINUTES multiplied its traffic one-for-one. It was our own rate limit, not our
 * compute (a full cycle takes ~10s), that pinned the interval at 7 minutes. With this, a
 * one-minute scan re-requests a given mint at most every TTL minutes, so a steady-state cycle only
 * pays for candidates that are newly in band.
 *
 * A short TTL, never a permanent one: holder distribution, dev wallet % and the risk score all
 * move constantly, unlike mint authority revocation or Mayhem Mode.
 *
 * Failures are never cached - only "here is the report" and "RugCheck has no report for this mint"
 * are written. A cached transport blip would keep a token out of every user's feed for the whole
 * TTL, and the rug screen fails closed on missing data, so that error is silent and expensive.
 */
export async function resolveRugProfiles(
  mintAddresses: string[],
  rugCheck: RugCheckClient,
  ttlMinutes: number,
): Promise<RugProfileResolution> {
  const unique = [...new Set(mintAddresses)];
  const profiles = new Map<string, RugCheckProfile>();
  const absent = new Set<string>();
  if (unique.length === 0) {
    return { profiles, absent, stats: { requested: 0, cached: 0, fetched: 0, failed: 0 } };
  }

  const fresh = await prisma.rugCheckCache.findMany({
    where: {
      mintAddress: { in: unique },
      checkedAt: { gt: new Date(Date.now() - ttlMinutes * 60_000) },
    },
  });

  const hit = new Set<string>();
  for (const row of fresh) {
    if (row.profile === null) {
      // A cached 404. Worth remembering: a brand-new mint RugCheck hasn't indexed would otherwise
      // be re-requested on every single cycle, which is the busiest case, not the rarest.
      absent.add(row.mintAddress);
      hit.add(row.mintAddress);
      continue;
    }
    const parsed = cachedProfileSchema.safeParse(row.profile);
    if (!parsed.success) {
      logger.warn("discarding unparseable cached profile", { mint: row.mintAddress });
      continue;
    }
    profiles.set(row.mintAddress, parsed.data as RugCheckProfile);
    hit.add(row.mintAddress);
  }

  const stale = unique.filter((mint) => !hit.has(mint));
  let failed = 0;
  if (stale.length > 0) {
    const results = await rugCheck.getProfileResults(stale);
    const writes: { mintAddress: string; profile: RugCheckProfile | null }[] = [];

    for (const mint of stale) {
      const result = results.get(mint);
      if (result?.status === "found") {
        profiles.set(mint, result.profile);
        writes.push({ mintAddress: mint, profile: result.profile });
      } else if (result?.status === "absent") {
        absent.add(mint);
        writes.push({ mintAddress: mint, profile: null });
      } else {
        // "failed", or no entry at all. Left uncached so the next cycle retries immediately.
        failed += 1;
      }
    }

    const checkedAt = new Date();
    await Promise.all(
      writes.map((write) => {
        // Prisma.DbNull is a SQL NULL in the column; a bare `null` on a nullable Json field is
        // ambiguous with the JSON value `null`, so it has to be spelled out.
        const profile =
          write.profile === null ? Prisma.DbNull : (write.profile as unknown as Prisma.InputJsonObject);
        return prisma.rugCheckCache
          .upsert({
            where: { mintAddress: write.mintAddress },
            create: { mintAddress: write.mintAddress, profile, checkedAt },
            update: { profile, checkedAt },
          })
          .catch((err: unknown) => {
            // A cache write failing is not worth failing the scan over - the profile is already
            // in hand and this cycle proceeds normally, just without the saving next cycle.
            logger.warn("failed to cache rugcheck profile", { mint: write.mintAddress, error: String(err) });
          });
      }),
    );
  }

  const stats = { requested: unique.length, cached: hit.size, fetched: stale.length - failed, failed };
  logger.info("resolved rugcheck profiles", stats);
  return { profiles, absent, stats };
}
