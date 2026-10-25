import { describe, expect, it } from "vitest";
import { sig2 } from "./graph.js";
import { holdersNote } from "../routes/asyl.js";

describe("sig2", () => {
  it("keeps two significant figures without trailing zeros or exponents", () => {
    expect(sig2(0.05)).toBe("0.05");
    expect(sig2(1.5)).toBe("1.5");
    expect(sig2(2)).toBe("2");
    expect(sig2(12.34)).toBe("12");
    expect(sig2(0.00001)).toBe("<0.0001");
    expect(sig2(0)).toBe("0");
  });
});

describe("holdersNote", () => {
  const now = Date.UTC(2026, 9, 25, 12, 0);
  it("says how old a holder reading is, and how to get the current list once it's old", () => {
    expect(holdersNote(50, new Date(now - 5 * 60_000), true, now)).toBe(
      "Top 50 holders as TrenchScanner read them 5 min ago (11:55 UTC on 2026-10-25).",
    );
    expect(holdersNote(50, new Date(now - 3 * 86_400_000), false, now)).toBe(
      "Top 50 holders as TrenchScanner read them 3 days ago (12:00 UTC on 2026-10-22). Pro Mode can read the current list from the chain.",
    );
    expect(holdersNote(0, null, true, now)).toContain("Live from the chain under Show holders");
  });
});
