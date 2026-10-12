import { describe, expect, it } from "vitest";
import type { LeaderboardEntry } from "../api";
import { byLast24h } from "./ModelPicker";

const entry = (id: string, rank: number, graded: number, rate: number | null): LeaderboardEntry =>
  ({
    id,
    rank,
    last24h: { graded, hitRate2xPct: rate, avgReturnPct: null, qualifies: graded >= 30 },
  }) as never;

describe("byLast24h", () => {
  it("lists ranked models by 24h 2x rate, then the rest by record length", () => {
    const rows = byLast24h([
      entry("a", 1, 40, 20),
      entry("thin", 2, 5, 80),
      entry("b", 3, 40, 30),
      entry("c", 4, 60, 30),
      entry("none", 5, 0, null),
    ]);
    expect(rows.map((e) => e.id)).toEqual(["c", "b", "a", "thin", "none"]);
  });
});
