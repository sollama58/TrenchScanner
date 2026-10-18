-- The smoothed $ASDFASDFA price the Sacrifice is charged at (ASDF fee plan, Build guide step 2):
-- ASDF per SOL sampled every 15 seconds from two sources, pruned after 25 hours (asdfPrice.ts).
CREATE TABLE IF NOT EXISTS "AsdfPriceSample" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "asdfPerSol" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "AsdfPriceSample_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AsdfPriceSample_at_idx" ON "AsdfPriceSample"("at");
