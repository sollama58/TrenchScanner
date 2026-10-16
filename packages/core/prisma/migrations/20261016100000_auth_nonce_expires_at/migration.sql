-- The nightly cleanup deletes sign-in nonces by expiresAt (cleanupJob's `nonces` stage, database
-- audit 2026-10-16, A9); the table had indexes on walletAddress and nonce only, so that delete
-- read every row. A few rows live at a time, so a plain CREATE INDEX is safe here.
CREATE INDEX IF NOT EXISTS "AuthNonce_expiresAt_idx" ON "AuthNonce"("expiresAt");
