import { describe, expect, it } from "vitest";
import { liveConvictionLines } from "./convictionLine.js";

describe("liveConvictionLines", () => {
  it("puts each seat's line at its own top share of live scores", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ trees: i / 1000, forest: i / 2000 }));
    const lines = liveConvictionLines(rows, 0.995, 200);
    // Top half-percent of 1,000 is the 5 best: 0.995..0.999 for trees, half that for forest.
    expect(lines.get("trees")).toBeCloseTo(0.995);
    expect(lines.get("forest")).toBeCloseTo(0.4975);
  });

  it("gives no line to a seat with too few scores", () => {
    const rows = [
      ...Array.from({ length: 300 }, (_, i) => ({ trees: i / 300 })),
      ...Array.from({ length: 50 }, (_, i) => ({ narrative: i / 50 })),
    ];
    const lines = liveConvictionLines(rows, 0.995, 200);
    expect(lines.has("trees")).toBe(true);
    expect(lines.has("narrative")).toBe(false);
  });

  it("takes at least the single best score, and skips junk rows and values", () => {
    const rows: unknown[] = [
      null,
      "x",
      [1],
      { trees: Number.NaN },
      { trees: "0.9" },
      { trees: 0.2 },
      { trees: 0.7 },
    ];
    expect(liveConvictionLines(rows, 0.9999, 1).get("trees")).toBe(0.7);
  });
});
