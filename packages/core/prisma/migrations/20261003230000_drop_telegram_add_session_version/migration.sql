-- Every statement is idempotent (IF EXISTS / IF NOT EXISTS, or a no-op once applied) so this can
-- be re-run after a failed first attempt. In production it failed on 2026-10-03 at 21:27:56 UTC
-- (P3009), which blocks every later deploy until it is marked rolled back and re-run - whatever
-- subset of these the first attempt left applied.

-- Telegram alerts are removed entirely: the link table, its enum, and the per-match delivery columns.
DROP TABLE IF EXISTS "TelegramLink";
DROP TYPE IF EXISTS "AlertMode";
ALTER TABLE "Match" DROP COLUMN IF EXISTS "deliveredTelegram",
DROP COLUMN IF EXISTS "digestSentAt";
DELETE FROM "SystemHeartbeat" WHERE "job" = 'digest';

-- Browser sessions become revocable: signing out bumps this, and older tokens stop verifying.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- One active filter per user from now on: keep each user's most recently updated active filter.
UPDATE "UserFilter" f SET "isActive" = false
WHERE f."isActive"
  AND f."id" <> (
    SELECT k."id" FROM "UserFilter" k
    WHERE k."userId" = f."userId" AND k."isActive"
    ORDER BY k."updatedAt" DESC, k."id" DESC
    LIMIT 1
  );
