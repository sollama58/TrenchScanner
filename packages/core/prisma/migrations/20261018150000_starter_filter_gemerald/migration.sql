-- The filter new accounts start with (user ask 2026-10-18: "set it to the current Gemerald filter
-- (rename it Default for new users, make sure to clone it in its current form so it doesnt track
-- future changes, just like the Gems model)"; core's filters/starterFilterStore.ts). Copied the
-- same way as Gems' gate (20261017020000_gems_gate): every column but identity, ownership, state
-- and card styling, once, and never following later edits to the filter.
-- No Gemerald row leaves the table empty and new accounts get the built-in starter filter.
-- ON CONFLICT DO NOTHING so a re-run never overwrites the frozen copy.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "StarterFilter" (
    "id" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "sourceFilterId" TEXT NOT NULL,
    "sourceFilterName" TEXT NOT NULL,
    "sourceCriteriaChangedAt" TIMESTAMP(3),
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StarterFilter_pkey" PRIMARY KEY ("id")
);

INSERT INTO "StarterFilter" ("id", "criteria", "sourceFilterId", "sourceFilterName", "sourceCriteriaChangedAt")
SELECT 'default',
       to_jsonb(f) - 'id' - 'userId' - 'name' - 'color' - 'icon' - 'isActive' - 'createdAt'
                   - 'updatedAt' - 'armedAt' - 'shareOnLeaderboard' - 'criteriaChangedAt'
                   - 'bestRank' - 'deletedAt',
       f."id",
       f."name",
       f."criteriaChangedAt"
FROM "UserFilter" f
WHERE f."id" = 'cmv8hv6qa0002qxxboba7ln2d'
ON CONFLICT ("id") DO NOTHING;

-- The one-time move of existing accounts (user ask 2026-10-18: "Could we change all current default
-- filter users to this new default, just once?"): every live filter still exactly the built-in
-- starter (named Default, the five settings starterFilter.ts gives it, every other criterion
-- open) takes the frozen copy's criteria. A filter whose owner changed any of it is left alone.
-- Name, colour, icon, on/off and sharing are kept. Like a criteria edit through PATCH /filters it
-- starts a new record (criteriaChangedAt) and alerts only on what newly matches (armedAt).
-- Production's scan band has always been $10k-$1M (render.yaml MCAP_FILTER_MIN/MAX).
-- Runs once, as a migration; nothing re-applies it.
UPDATE "UserFilter" f
   SET "mcapMin" = g."mcapMin",
       "mcapMax" = g."mcapMax",
       "minVolumeMcapRatio" = g."minVolumeMcapRatio",
       "minHolderGrowthPct" = g."minHolderGrowthPct",
       "maxTop10HolderPct" = g."maxTop10HolderPct",
       "maxLargestHolderPct" = g."maxLargestHolderPct",
       "maxDevWalletPct" = g."maxDevWalletPct",
       "maxRiskScore" = g."maxRiskScore",
       "excludeCriticalRiskFlags" = g."excludeCriticalRiskFlags",
       "minTokenAgeMinutes" = g."minTokenAgeMinutes",
       "maxTokenAgeMinutes" = g."maxTokenAgeMinutes",
       "narrativeKeywords" = g."narrativeKeywords",
       "minScore" = g."minScore",
       "maxFreshTop10WalletPct" = g."maxFreshTop10WalletPct",
       "maxEmptyTop10WalletPct" = g."maxEmptyTop10WalletPct",
       "maxSniperTop10WalletPct" = g."maxSniperTop10WalletPct",
       "maxSniperTopHolderCount" = g."maxSniperTopHolderCount",
       "maxLinkedWalletPct" = g."maxLinkedWalletPct",
       "maxLinkedWalletCount" = g."maxLinkedWalletCount",
       "maxSameTimeFundedPct" = g."maxSameTimeFundedPct",
       "maxSameTimeFundedCount" = g."maxSameTimeFundedCount",
       "maxBundledWalletCount" = g."maxBundledWalletCount",
       "maxLinkedCreatorPct" = g."maxLinkedCreatorPct",
       "maxKolBundledPct" = g."maxKolBundledPct",
       "maxBundledSupplyPct" = g."maxBundledSupplyPct",
       "maxTransferredSupplyPct" = g."maxTransferredSupplyPct",
       "minLiveHolderCount" = g."minLiveHolderCount",
       "minCexFundedPct" = g."minCexFundedPct",
       "maxCexFundedPct" = g."maxCexFundedPct",
       "minCexFundedCount" = g."minCexFundedCount",
       "maxCexFundedCount" = g."maxCexFundedCount",
       "maxFlaggedBuySol" = g."maxFlaggedBuySol",
       "launchpads" = g."launchpads",
       "minFirstBuyersHolding" = g."minFirstBuyersHolding",
       "maxFirstBuyersHolding" = g."maxFirstBuyersHolding",
       "narrativeCategories" = g."narrativeCategories",
       "excludeNarrativeCategories" = g."excludeNarrativeCategories",
       "excludeCopycats" = g."excludeCopycats",
       "excludeNarrativeRedFlags" = g."excludeNarrativeRedFlags",
       "excludeUnrelatedX" = g."excludeUnrelatedX",
       "requireTrendMatch" = g."requireTrendMatch",
       "excludeLateCopies" = g."excludeLateCopies",
       "criteriaChangedAt" = CURRENT_TIMESTAMP,
       "armedAt" = CURRENT_TIMESTAMP,
       "bestRank" = NULL,
       "updatedAt" = CURRENT_TIMESTAMP
  FROM "StarterFilter" s
 CROSS JOIN LATERAL jsonb_populate_record(NULL::"UserFilter", s."criteria") g
 WHERE s."id" = 'default'
   AND f."name" = 'Default'
   AND f."deletedAt" IS NULL
   AND f."mcapMin" = 10000
   AND f."mcapMax" = 1000000
   AND f."minVolumeMcapRatio" IS NULL
   AND f."minHolderGrowthPct" IS NULL
   AND f."maxTop10HolderPct" IS NULL
   AND f."maxLargestHolderPct" IS NULL
   AND f."maxDevWalletPct" IS NULL
   AND f."maxRiskScore" = 70
   AND f."excludeCriticalRiskFlags" = false
   AND f."minTokenAgeMinutes" = 0.5
   AND f."maxTokenAgeMinutes" IS NULL
   AND cardinality(f."narrativeKeywords") = 0
   AND f."minScore" IS NULL
   AND f."maxFreshTop10WalletPct" = 40
   AND f."maxEmptyTop10WalletPct" = 60
   AND f."maxSniperTop10WalletPct" IS NULL
   AND f."maxSniperTopHolderCount" IS NULL
   AND f."maxLinkedWalletPct" IS NULL
   AND f."maxLinkedWalletCount" IS NULL
   AND f."maxSameTimeFundedPct" IS NULL
   AND f."maxSameTimeFundedCount" IS NULL
   AND f."maxBundledWalletCount" IS NULL
   AND f."maxLinkedCreatorPct" IS NULL
   AND f."maxKolBundledPct" IS NULL
   AND f."maxBundledSupplyPct" IS NULL
   AND f."maxTransferredSupplyPct" IS NULL
   AND f."minLiveHolderCount" IS NULL
   AND f."minCexFundedPct" IS NULL
   AND f."maxCexFundedPct" IS NULL
   AND f."minCexFundedCount" IS NULL
   AND f."maxCexFundedCount" IS NULL
   AND f."maxFlaggedBuySol" IS NULL
   AND cardinality(f."launchpads") = 0
   AND f."minFirstBuyersHolding" IS NULL
   AND f."maxFirstBuyersHolding" IS NULL
   AND cardinality(f."narrativeCategories") = 0
   AND cardinality(f."excludeNarrativeCategories") = 0
   AND f."excludeCopycats" = false
   AND f."excludeNarrativeRedFlags" = false
   AND f."excludeUnrelatedX" = false
   AND f."requireTrendMatch" = false
   AND f."excludeLateCopies" = false;
