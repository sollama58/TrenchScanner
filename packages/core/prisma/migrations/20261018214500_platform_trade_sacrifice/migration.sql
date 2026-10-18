-- The Sacrifice on each Pro trade (ASDF fee plan, Build guide step 5): what it took (or, in
-- shadow mode, would have taken) from the burned pot, the price, the tier and the mode.
ALTER TABLE "PlatformTrade" ADD COLUMN IF NOT EXISTS "sacrificeAsdfRaw" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "PlatformTrade" ADD COLUMN IF NOT EXISTS "asdfPerSol" TEXT;
ALTER TABLE "PlatformTrade" ADD COLUMN IF NOT EXISTS "feeTier" TEXT;
ALTER TABLE "PlatformTrade" ADD COLUMN IF NOT EXISTS "sacrificeMode" TEXT;
