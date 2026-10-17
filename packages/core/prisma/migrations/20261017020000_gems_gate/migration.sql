-- Gems' gate (user ask 2026-10-17: "only considers tokens that pass the Gemerald filter (as it
-- currently stands, copy it in its current form)"; core's curation/modelGate.ts). The Gemerald
-- filter's criteria are copied here once and never follow later edits to the filter: every column
-- but identity, ownership, state and card styling, under the same names FilterCriteria uses.
-- No Gemerald row (deleted before this ran) leaves the table empty and Gems calls nothing.
-- ON CONFLICT DO NOTHING so a re-run never overwrites the frozen copy.
CREATE TABLE IF NOT EXISTS "ModelGate" (
    "id" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "sourceFilterId" TEXT NOT NULL,
    "sourceFilterName" TEXT NOT NULL,
    "sourceCriteriaChangedAt" TIMESTAMP(3),
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelGate_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ModelGate" ("id", "criteria", "sourceFilterId", "sourceFilterName", "sourceCriteriaChangedAt")
SELECT 'gemerald',
       to_jsonb(f) - 'id' - 'userId' - 'name' - 'color' - 'icon' - 'isActive' - 'createdAt'
                   - 'updatedAt' - 'armedAt' - 'shareOnLeaderboard' - 'criteriaChangedAt'
                   - 'bestRank' - 'deletedAt',
       f."id",
       f."name",
       f."criteriaChangedAt"
FROM "UserFilter" f
WHERE f."id" = 'cmv8hv6qa0002qxxboba7ln2d'
ON CONFLICT ("id") DO NOTHING;
