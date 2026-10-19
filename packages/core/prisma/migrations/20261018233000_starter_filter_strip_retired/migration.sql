-- The Default filter drops retired criteria (user decision 2026-10-18, "Strip retired rules from the
-- Default filter?": "Strip them"). The frozen Gemerald copy (20261018150000_starter_filter_gemerald)
-- carried every column Gemerald had set, including the ones the Filters tab retired on 10-13/10-15:
-- six that still apply and show as "(old)" (snipers in the top 10, linked top holders, top holders
-- funded in the same minute, supply held by linked wallets, supply funded in the same minute, KOL
-- Bundled %; Bundled % and snipers in the top 25 replaced them) and the two CEX-funded % bounds,
-- read by nothing since the counts replaced them. Core drops them on read too (parseStarterCriteria).
-- Runs once, as a migration.
SET LOCAL lock_timeout = '5s';

-- First the Defaults the one-time switch gave the frozen copy and nobody has edited since: every
-- criterion the copy holds still equal to it. A Default its owner changed is left alone. Like a
-- criteria edit through PATCH /filters, dropping a rule that applied starts a new record and alerts
-- only on what newly matches; dropping only the dead CEX % bounds changes nothing that matches.
UPDATE "UserFilter" f
   SET "maxSniperTop10WalletPct" = NULL,
       "maxLinkedWalletCount" = NULL,
       "maxSameTimeFundedCount" = NULL,
       "maxLinkedWalletPct" = NULL,
       "maxSameTimeFundedPct" = NULL,
       "maxKolBundledPct" = NULL,
       "minCexFundedPct" = NULL,
       "maxCexFundedPct" = NULL,
       "criteriaChangedAt" = CASE WHEN COALESCE(f."maxSniperTop10WalletPct", f."maxLinkedWalletCount",
                                                f."maxSameTimeFundedCount", f."maxLinkedWalletPct",
                                                f."maxSameTimeFundedPct", f."maxKolBundledPct") IS NOT NULL
                                  THEN CURRENT_TIMESTAMP ELSE f."criteriaChangedAt" END,
       "armedAt" = CASE WHEN COALESCE(f."maxSniperTop10WalletPct", f."maxLinkedWalletCount",
                                      f."maxSameTimeFundedCount", f."maxLinkedWalletPct",
                                      f."maxSameTimeFundedPct", f."maxKolBundledPct") IS NOT NULL
                        THEN CURRENT_TIMESTAMP ELSE f."armedAt" END,
       "bestRank" = CASE WHEN COALESCE(f."maxSniperTop10WalletPct", f."maxLinkedWalletCount",
                                       f."maxSameTimeFundedCount", f."maxLinkedWalletPct",
                                       f."maxSameTimeFundedPct", f."maxKolBundledPct") IS NOT NULL
                         THEN NULL ELSE f."bestRank" END,
       "updatedAt" = CURRENT_TIMESTAMP
  FROM "StarterFilter" s
 WHERE s."id" = 'default'
   AND f."name" = 'Default'
   AND f."deletedAt" IS NULL
   AND COALESCE(f."maxSniperTop10WalletPct", f."maxLinkedWalletCount", f."maxSameTimeFundedCount",
                f."maxLinkedWalletPct", f."maxSameTimeFundedPct", f."maxKolBundledPct",
                f."minCexFundedPct", f."maxCexFundedPct") IS NOT NULL
   AND NOT EXISTS (
         SELECT 1
           FROM jsonb_each(s."criteria") c
          WHERE (to_jsonb(f) -> c.key) IS DISTINCT FROM c.value
       );

-- Then the frozen copy itself, so new accounts start without them.
UPDATE "StarterFilter"
   SET "criteria" = "criteria" - 'maxSniperTop10WalletPct' - 'maxLinkedWalletCount'
                               - 'maxSameTimeFundedCount' - 'maxLinkedWalletPct'
                               - 'maxSameTimeFundedPct' - 'maxKolBundledPct'
                               - 'minCexFundedPct' - 'maxCexFundedPct'
 WHERE "id" = 'default';
