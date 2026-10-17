-- Token.creator: the wallet that launched the coin, for the token modal's Dev card (user bug report
-- 2026-10-17: most coins said "The creator wallet isn't known for this coin yet", since the card
-- read only the trade tape and TokenSage). Backfilled from what is already stored: the trade
-- tapes, the RugCheck cache (its last 2 days) and TokenSage's market.creator when it names a
-- wallet. Each UPDATE fills only rows still null, so the first source wins. IF NOT EXISTS so a
-- partly-applied run can be re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "creator" TEXT;

UPDATE "Token" t SET "creator" = tt."creator"
FROM "TokenTradeTape" tt
WHERE tt."tokenId" = t."id" AND t."creator" IS NULL
  AND tt."creator" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$';

UPDATE "Token" t SET "creator" = rc."profile"->>'creator'
FROM "RugCheckCache" rc
WHERE rc."mintAddress" = t."mintAddress" AND t."creator" IS NULL
  AND jsonb_typeof(rc."profile") = 'object'
  AND rc."profile"->>'creator' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$';

UPDATE "Token" t SET "creator" = tn."analysis"->'market'->>'creator'
FROM "TokenNarrative" tn
WHERE tn."mintAddress" = t."mintAddress" AND t."creator" IS NULL
  AND jsonb_typeof(tn."analysis") = 'object'
  AND COALESCE(tn."analysis"->'market'->>'creator_kind', 'wallet') = 'wallet'
  AND tn."analysis"->'market'->>'creator' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$';
