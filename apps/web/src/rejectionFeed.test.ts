import { describe, expect, it } from "vitest";
import { reasonCounts, rejectionKey, visibleRejections, type Rejection } from "./rejectionFeed";

const FRESH = {
  text: "8 of 10 top holders are fresh (over 7)",
  label: "N of N top holders are fresh (over 7)",
};
const LARGEST = {
  text: "largest holder owns 12.0% of supply (over 10%)",
  label: "largest holder owns N% of supply (over 10%)",
};

const row = (mint: string, reasons: Rejection["reasons"]): Rejection => ({
  mint,
  symbol: mint.toUpperCase(),
  firstSeenAt: "2026-10-17T15:00:00Z",
  takenAt: "2026-10-17T16:00:00Z",
  marketCapUsd: 20_000,
  passedSince: false,
  reasons,
});

describe("rejection feed", () => {
  const rows = [row("a", [FRESH, LARGEST]), row("b", [FRESH]), row("c", [LARGEST]), row("d", [])];

  it("counts each reason once per token, most common first", () => {
    expect(reasonCounts([...rows, row("e", [FRESH, FRESH])])).toEqual([
      { label: FRESH.label, count: 3 },
      { label: LARGEST.label, count: 2 },
    ]);
  });

  it("drops a token only when every one of its reasons is hidden", () => {
    const shown = visibleRejections(rows, new Set([FRESH.label]));
    expect(shown.map((r) => r.mint)).toEqual(["a", "c", "d"]);
    expect(shown[0]).toMatchObject({ reasons: [LARGEST], hiddenCount: 1 });
    expect(shown[1]).toMatchObject({ reasons: [LARGEST], hiddenCount: 0 });
  });

  it("shows everything with nothing hidden, and nothing but reasonless rows with all hidden", () => {
    expect(visibleRejections(rows, new Set())).toHaveLength(4);
    expect(visibleRejections(rows, new Set([FRESH.label, LARGEST.label])).map((r) => r.mint)).toEqual(["d"]);
  });

  it("keys a row by token and scan", () => {
    expect(rejectionKey(rows[0]!)).toBe("a@2026-10-17T16:00:00Z");
  });
});
