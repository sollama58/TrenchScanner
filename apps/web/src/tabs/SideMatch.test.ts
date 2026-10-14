import { describe, expect, it } from "vitest";
import { fundingVerdict, span } from "./SideMatch";

describe("SideMatch", () => {
  it("writes durations in words", () => {
    expect(span(12)).toBe("12s");
    expect(span(-125)).toBe("2m 5s");
    expect(span(3_840)).toBe("1h 4m");
  });

  it("reads the funding tie", () => {
    const f = (funder: string | null) => ({
      status: funder ? "found" : "none",
      funder,
      exchange: null,
      amountSol: null,
      fundedAt: null,
    });
    const base = {
      kol: { wallet: "k", name: null, funding: f("a") },
      side: { wallet: "s", funding: f("b") },
    };
    expect(fundingVerdict({ ...base, fundingLink: "same-funder" }).tone).toBe("strong");
    expect(fundingVerdict({ ...base, fundingLink: "exchange" }).tone).toBe("weak");
    expect(fundingVerdict({ ...base, fundingLink: null }).text).toBe("Different funders");
    expect(fundingVerdict({ ...base, side: { wallet: "s", funding: null }, fundingLink: null }).text).toBe(
      "Funders not read yet",
    );
  });
});
