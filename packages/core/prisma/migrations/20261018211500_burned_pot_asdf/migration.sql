-- The burned pot held in $ASDFASDFA (owner decision 2026-10-18, "Hold in ASDF"; ASDF fee plan,
-- Build guide step 1): every "burned" row carries the signed base units it adds or takes, and a
-- wallet's burned credits are their sum over the current tokensPerCredit (credits.ts creditPots).
-- No credit count is rewritten: `delta` stays as it was on every row.
ALTER TABLE "BurnCreditEntry" ADD COLUMN IF NOT EXISTS "asdfRaw" BIGINT;
ALTER TABLE "BurnCreditEntry" ADD COLUMN IF NOT EXISTS "tradeSignature" TEXT;

-- A trade is charged once and refunded at most once: one Sacrifice row of each kind per signature.
CREATE UNIQUE INDEX IF NOT EXISTS "BurnCreditEntry_kind_tradeSignature_key"
    ON "BurnCreditEntry"("kind", "tradeSignature");

-- A burn holds what it burned, read from the chain when it was credited.
UPDATE "BurnCreditEntry"
SET "asdfRaw" = "rawAmount"::NUMERIC::BIGINT
WHERE "source" = 'burned' AND "kind" = 'burn' AND "asdfRaw" IS NULL AND "rawAmount" ~ '^[0-9]+$';

-- Any other burned row (a spend, or a burn without its amount) is its credits at the rate in
-- force when it was written: the newest burn credited at or before it, else the saved price, else
-- the default 100. 10^6: the mint's decimals (constants.ts SUBSCRIPTION_MINT_DECIMALS).
UPDATE "BurnCreditEntry" AS e
SET "asdfRaw" = e."delta"::BIGINT * COALESCE(
        e."tokensPerCredit",
        (SELECT b."tokensPerCredit" FROM "BurnCreditEntry" b
         WHERE b."kind" = 'burn' AND b."tokensPerCredit" IS NOT NULL AND b."createdAt" <= e."createdAt"
         ORDER BY b."createdAt" DESC LIMIT 1),
        (SELECT s."tokensPerCredit" FROM "BurnCreditSettings" s WHERE s."id" = 'burn-credits'),
        100
    )::BIGINT * 1000000
WHERE e."source" = 'burned' AND e."asdfRaw" IS NULL;
