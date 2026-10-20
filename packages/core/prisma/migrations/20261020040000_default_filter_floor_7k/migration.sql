-- The Default filter's market-cap floor follows the scan band down from $10k to $7k (user decision
-- 2026-10-20, "Lower users' saved Default filters and the new-account starter filter from $10k to
-- $7k?": "Lower to $7k"). Calls now go out from $7k (render.yaml MCAP_FILTER_MIN), so a $10k
-- Default hid the earliest calls from everyone who never touched it.
-- Runs once, as a migration.
SET LOCAL lock_timeout = '5s';

-- First the Defaults nobody has edited: every criterion the frozen copy holds still equal to it,
-- the same test as 20261018233000_starter_filter_strip_retired. A Default its owner changed is left
-- alone. Like a criteria edit through PATCH /filters (apps/api/src/routes/filters.ts) the old
-- settings are kept as a FilterVersion, a new record starts (criteriaChangedAt) and the filter
-- alerts only on what newly matches (armedAt).
WITH targets AS (
  SELECT f.*
    FROM "UserFilter" f
    JOIN "StarterFilter" s ON s."id" = 'default'
   WHERE f."name" = 'Default'
     AND f."deletedAt" IS NULL
     AND f."mcapMin" = 10000
     AND (s."criteria" ->> 'mcapMin')::float8 = 10000
     AND NOT EXISTS (
           SELECT 1
             FROM jsonb_each(s."criteria") c
            WHERE (to_jsonb(f) -> c.key) IS DISTINCT FROM c.value
         )
),
versions AS (
  INSERT INTO "FilterVersion" ("id", "filterId", "version", "criteria", "startedAt", "endedAt")
  SELECT 'fv7k' || md5(t."id" || clock_timestamp()::text),
         t."id",
         (SELECT count(*) FROM "FilterVersion" v WHERE v."filterId" = t."id") + 1,
         to_jsonb(t) - 'id' - 'userId' - 'name' - 'color' - 'icon' - 'isActive' - 'createdAt'
                     - 'updatedAt' - 'armedAt' - 'shareOnLeaderboard' - 'criteriaChangedAt'
                     - 'bestRank' - 'deletedAt',
         t."criteriaChangedAt",
         CURRENT_TIMESTAMP
    FROM targets t
)
UPDATE "UserFilter" f
   SET "mcapMin" = 7000,
       "criteriaChangedAt" = CURRENT_TIMESTAMP,
       "armedAt" = CURRENT_TIMESTAMP,
       "bestRank" = NULL,
       "updatedAt" = CURRENT_TIMESTAMP
  FROM targets t
 WHERE f."id" = t."id";

-- Then the frozen copy itself, so new accounts start at $7k.
UPDATE "StarterFilter"
   SET "criteria" = jsonb_set("criteria", '{mcapMin}', '7000'::jsonb)
 WHERE "id" = 'default'
   AND ("criteria" ->> 'mcapMin')::float8 = 10000;
