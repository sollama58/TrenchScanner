-- The snipers figure now counts the launch's first 15 buyers, not 25 (2026-10-08). A filter's
-- bounds were set against "of 25", so they are rescaled to keep the same share: 10 of 25 becomes
-- 6 of 15. The scale is monotonic, so a filter's min stays at or under its max.
--
-- One DO block, so it applies whole or not at all, and the column comment marks it done: a
-- re-run must not shrink the bounds a second time.
DO $$
BEGIN
  IF col_description('"UserFilter"'::regclass,
       (SELECT attnum FROM pg_attribute
        WHERE attrelid = '"UserFilter"'::regclass AND attname = 'minFirstBuyersHolding'))
     IS DISTINCT FROM 'of the first 15 buyers' THEN
    UPDATE "UserFilter"
    SET "minFirstBuyersHolding" = CASE WHEN "minFirstBuyersHolding" IS NULL THEN NULL
          ELSE LEAST(15, ROUND("minFirstBuyersHolding" * 15.0 / 25.0))::int END,
        "maxFirstBuyersHolding" = CASE WHEN "maxFirstBuyersHolding" IS NULL THEN NULL
          ELSE LEAST(15, ROUND("maxFirstBuyersHolding" * 15.0 / 25.0))::int END
    WHERE "minFirstBuyersHolding" IS NOT NULL OR "maxFirstBuyersHolding" IS NOT NULL;
    COMMENT ON COLUMN "UserFilter"."minFirstBuyersHolding" IS 'of the first 15 buyers';
  END IF;
END
$$;
