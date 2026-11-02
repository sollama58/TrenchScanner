-- The rate the alert card quotes, apart from the call's own calibrated rate (which the FDSA desk
-- screens on and must keep): the own band from CARD_BAND_MIN_PCT up, else the seat's pooled rate
-- (curation/liveRankRates.ts servedRate; audit 2026-11-02 GF-3, user decision). A nullable column
-- with no default is a catalog-only change on a large table; the lock timeout keeps a long reader
-- from holding the deploy.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CuratedAlert" ADD COLUMN IF NOT EXISTS "shownPct" DOUBLE PRECISION;
