-- The safety screen's accepted / rejected tokens per hour, for the Lighthouse's Likely Rugs gauge.
ALTER TABLE "LighthouseHour" ADD COLUMN IF NOT EXISTS "screenAccepted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LighthouseHour" ADD COLUMN IF NOT EXISTS "screenRejected" INTEGER NOT NULL DEFAULT 0;
