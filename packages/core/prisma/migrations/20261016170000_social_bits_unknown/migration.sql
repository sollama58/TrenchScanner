-- hasTwitter / hasWebsite: null = no source has read the coin's socials yet (data-correctness
-- audit 2026-10-16, user decision). Until now a PumpPortal, Jupiter or DexScreener row whose
-- details were never read stored false, and the models learned "0 = unread". Existing rows are
-- left as they are (the training-side masks cover the eras); only new writes carry null. Dropping
-- a NOT NULL and a default is a catalog-only change; the lock timeout keeps the Token ALTER
-- queued behind a long read from stalling the scanner (scripts/migrate-deploy.sh retries it).
-- Safe to re-run: dropping an absent constraint or default is a no-op.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Token"
  ALTER COLUMN "hasTwitter" DROP NOT NULL,
  ALTER COLUMN "hasTwitter" DROP DEFAULT,
  ALTER COLUMN "hasWebsite" DROP NOT NULL,
  ALTER COLUMN "hasWebsite" DROP DEFAULT;
