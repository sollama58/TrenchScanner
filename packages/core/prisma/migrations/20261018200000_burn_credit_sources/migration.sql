-- Burn Credit sources (user ask 2026-10-18): every ledger row says which pot it belongs to, so a
-- subscriber's 10 free daily credits and admin grants pay for lookups but never for trading
-- (schema.prisma BurnCreditEntry.source, credits.ts spendCredits).
-- "burned" (bought by a burn), "granted" (an admin grant) or "daily" (the subscriber allowance,
-- which only ever has spend rows and is not part of the balance).
ALTER TABLE "BurnCreditEntry" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'burned';

UPDATE "BurnCreditEntry" SET "source" = 'granted' WHERE "kind" = 'grant';

-- Lookups spent before this column existed drew on grants first, the order spendCredits uses from
-- now on: each wallet's spends, oldest first, are marked "granted" until they add up to its
-- grants, the rest stay "burned". (Approximate where a grant came after the spends it now covers;
-- the totals per wallet are what the balances read.)
WITH granted AS (
    SELECT "wallet", SUM("delta") AS total
    FROM "BurnCreditEntry"
    WHERE "kind" = 'grant'
    GROUP BY "wallet"
    HAVING SUM("delta") > 0
), spends AS (
    SELECT e."id",
           SUM(-e."delta") OVER (PARTITION BY e."wallet" ORDER BY e."createdAt", e."id") AS running,
           g.total
    FROM "BurnCreditEntry" e
    JOIN granted g ON g."wallet" = e."wallet"
    WHERE e."kind" = 'spend'
)
UPDATE "BurnCreditEntry" AS e
SET "source" = 'granted'
FROM spends s
WHERE e."id" = s."id" AND s.running <= s.total;
