-- A Burn Credit now costs 100 $ASDFASDFA (was 500). Moves the column default and any price an
-- admin saved, so production matches the code default. Lookup costs are left as they are.
-- Written to be safe to re-run (see scripts/check-migrations.sh).
ALTER TABLE "BurnCreditSettings" ALTER COLUMN "tokensPerCredit" SET DEFAULT 100;
UPDATE "BurnCreditSettings" SET "tokensPerCredit" = 100, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'burn-credits' AND "tokensPerCredit" <> 100;
