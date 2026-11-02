-- FDSA's paper caps, raised so its record fills faster (owner decision 2026-11-02, audit FD-4):
-- 12 open positions (6) on a 25 SOL paper bankroll (10). Six open at up to three hours each is
-- 48 position-hours a day, so a cluster of seven trade verdicts in a busy window was skipped "at
-- the open-position limit" and never retried, and the record under-sampled the hours the pool
-- doubles most. The desk row holds its config and bankroll (fdsa/desk.ts, paperDesk.ts
-- ensureFdsaDesk), so the new defaults in code reach production only through this row: the one
-- desk still on the 2026-11-01 figures is lifted in place, 15 SOL added to the bankroll and to
-- cash alike so P&L (equity less bankroll) is unchanged. Paper only; no real SOL is involved.
-- Re-runs safely: once applied the WHERE matches nothing. One small row, no lock_timeout needed.
UPDATE "FdsaDesk"
SET
  "config" = jsonb_set("config"::jsonb, '{maxOpenPositions}', '12'::jsonb),
  "bankrollLamports" = "bankrollLamports" + 15000000000,
  "cashLamports" = "cashLamports" + 15000000000
WHERE "id" = 'fdsa'
  AND ("config"::jsonb ->> 'maxOpenPositions')::int = 6
  AND "bankrollLamports" = 10000000000;
