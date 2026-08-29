-- Per-launch breakdown of a cached wallet's holdings.
--
-- The empty-wallet signal asks whether a top-10 holder owns anything besides the launch it is
-- holding, and a top-10 holder owns that launch by definition - so the launch's own value has to
-- come back out of the total. Keeping the breakdown here rather than keying the cache by
-- (wallet, mint) means one reading still serves every candidate the wallet holds.
--
-- Existing rows default to '{}', which makes them a cache miss for every candidate rather than a
-- wrong answer: they are re-fetched once and then carry the breakdown.
ALTER TABLE "WalletHoldingsCache" ADD COLUMN "perMintUsd" JSONB NOT NULL DEFAULT '{}';
