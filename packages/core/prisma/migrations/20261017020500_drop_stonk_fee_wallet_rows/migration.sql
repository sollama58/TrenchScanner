-- Stonks' fee wallet (core's stonksFees.ts) is never a trader or a holder, on any coin (owner
-- decision 2026-10-17). The tape and walletRiskJob already skip it; this drops the rows it earned
-- before they did, so nothing stored still counts its fee sweeps as trades. Both deletes are by
-- an indexed key (TokenWalletActivity's wallet index, WalletRisk's primary key) and match only that
-- wallet's rows, so they are quick and a re-run deletes nothing. The lock timeout keeps a delete
-- queued behind walletRiskJob's hourly rebuild from stalling writers (scripts/migrate-deploy.sh
-- retries it).
SET LOCAL lock_timeout = '5s';
DELETE FROM "TokenWalletActivity" WHERE "wallet" = '5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD';
DELETE FROM "WalletRisk" WHERE "wallet" = '5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD';
