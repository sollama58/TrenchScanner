-- The composite score was rebuilt (scoring/scorer.ts, notes/token-score-review-2026-10-06.md).
-- Each saved "min composite score" moves to the new score's value that lets through the same
-- share of filter matches as the old minimum did (prod matches 2026-10-03..06), so filters keep
-- about the same alert volume. Piecewise linear between the breakpoints below.
-- Re-runnable: the column comment marks the translation as done, and the DO block skips once it
-- is set, so a second run never translates a value twice.
DO $$
BEGIN
  IF col_description('"UserFilter"'::regclass,
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = '"UserFilter"'::regclass AND attname = 'minScore')) IS DISTINCT FROM 'composite score v2' THEN
    WITH bp(o, n) AS (
      VALUES (0::float8, 0::float8), (10, 10), (15, 22), (20, 36), (25, 52), (30, 68), (35, 75),
             (40, 80), (45, 83), (50, 85), (55, 86), (60, 86.5), (65, 87), (70, 87.5), (80, 88),
             (90, 88.5), (100, 100)
    ),
    seg AS (
      SELECT o, n, lead(o) OVER (ORDER BY o) AS o2, lead(n) OVER (ORDER BY o) AS n2 FROM bp
    )
    UPDATE "UserFilter" f
       SET "minScore" = round((s.n + (f."minScore" - s.o) * (s.n2 - s.n) / (s.o2 - s.o))::numeric, 1)::float8
      FROM seg s
     WHERE f."minScore" IS NOT NULL
       AND s.o2 IS NOT NULL
       AND f."minScore" >= s.o
       AND (f."minScore" < s.o2 OR (s.o2 = 100 AND f."minScore" <= 100));
    COMMENT ON COLUMN "UserFilter"."minScore" IS 'composite score v2';
  END IF;
END $$;
