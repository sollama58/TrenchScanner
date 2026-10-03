-- Telegram alerts are removed entirely: the link table, its enum, and the per-match delivery columns.
DROP TABLE "TelegramLink";
DROP TYPE "AlertMode";
ALTER TABLE "Match" DROP COLUMN "deliveredTelegram",
DROP COLUMN "digestSentAt";
DELETE FROM "SystemHeartbeat" WHERE "job" = 'digest';

-- Browser sessions become revocable: signing out bumps this, and older tokens stop verifying.
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- One active filter per user from now on: keep each user's most recently updated active filter.
UPDATE "UserFilter" f SET "isActive" = false
WHERE f."isActive"
  AND f."id" <> (
    SELECT k."id" FROM "UserFilter" k
    WHERE k."userId" = f."userId" AND k."isActive"
    ORDER BY k."updatedAt" DESC, k."id" DESC
    LIMIT 1
  );
