import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Most route tests share one real Postgres and count rows across tables (hit rates, the
    // leaderboard, admin tallies), so a file running alongside another reads the other's rows:
    // CI went red on contest, curated.stats and adminOps counts that came out high (2026-10-12).
    // Same reason and remedy as apps/worker's config.
    fileParallelism: false,
  },
});
