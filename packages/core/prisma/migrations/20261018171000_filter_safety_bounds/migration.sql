-- Filters can't be set looser than the safety screen lets through (user ask 2026-10-18: "set the
-- floor/ceiling we allow users to set, as the safety screen's max/min ... retroactive for any
-- current filters"; core's filters/filterBounds.ts holds the ceilings). Every filter, and the frozen
-- Default copy new accounts start from (StarterFilter), has each such field above its ceiling
-- lowered to it. Values inside the bounds and unset fields are left as they are. A value above
-- the ceiling only promised tokens the screen never alerts, so this changes what matches by
-- nothing beyond rounding on short holder lists, and leaves records (criteriaChangedAt) alone.
-- Runs once, as a migration; the API refuses values above the ceilings from here on.
SET LOCAL lock_timeout = '5s';

UPDATE "UserFilter"
   SET "maxTop10HolderPct" = LEAST("maxTop10HolderPct", 40),
       "maxLargestHolderPct" = LEAST("maxLargestHolderPct", 10),
       "maxFreshTop10WalletPct" = LEAST("maxFreshTop10WalletPct", 70),
       "maxEmptyTop10WalletPct" = LEAST("maxEmptyTop10WalletPct", 70),
       "maxSniperTop10WalletPct" = LEAST("maxSniperTop10WalletPct", 70),
       "maxSniperTopHolderCount" = LEAST("maxSniperTopHolderCount", 19),
       "maxLinkedWalletCount" = LEAST("maxLinkedWalletCount", 19),
       "maxBundledSupplyPct" = LEAST("maxBundledSupplyPct", 40),
       "minCexFundedCount" = LEAST("minCexFundedCount", 20),
       "maxCexFundedCount" = LEAST("maxCexFundedCount", 20),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "maxTop10HolderPct" > 40
    OR "maxLargestHolderPct" > 10
    OR "maxFreshTop10WalletPct" > 70
    OR "maxEmptyTop10WalletPct" > 70
    OR "maxSniperTop10WalletPct" > 70
    OR "maxSniperTopHolderCount" > 19
    OR "maxLinkedWalletCount" > 19
    OR "maxBundledSupplyPct" > 40
    OR "minCexFundedCount" > 20
    OR "maxCexFundedCount" > 20;

-- The frozen copy's criteria are JSON (20261018150000_starter_filter_gemerald); a key that is null
-- or absent stays so. Core clamps it again on read (parseStarterCriteria).
UPDATE "StarterFilter" s
   SET "criteria" = s."criteria" || (
         SELECT COALESCE(jsonb_object_agg(b.key, b.ceiling), '{}'::jsonb)
           FROM (VALUES ('maxTop10HolderPct', 40), ('maxLargestHolderPct', 10),
                        ('maxFreshTop10WalletPct', 70), ('maxEmptyTop10WalletPct', 70),
                        ('maxSniperTop10WalletPct', 70), ('maxSniperTopHolderCount', 19),
                        ('maxLinkedWalletCount', 19), ('maxBundledSupplyPct', 40),
                        ('minCexFundedCount', 20), ('maxCexFundedCount', 20)) AS b(key, ceiling)
          WHERE jsonb_typeof(s."criteria" -> b.key) = 'number'
            AND (s."criteria" ->> b.key)::float8 > b.ceiling
       );
