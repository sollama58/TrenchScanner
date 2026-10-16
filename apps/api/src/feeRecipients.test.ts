// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { feeRecipientOf } from "@trenchscanner/core";
import { feeRecipientCounts } from "./marketLighthouse.js";

describe("Lighthouse fee recipients", () => {
  it("folds TokenSage's fee destinations into four groups", () => {
    expect(feeRecipientOf("charity")).toBe("charity");
    expect(feeRecipientOf("holder_rewards")).toBe("holders or wallets");
    expect(feeRecipientOf("wallet")).toBe("holders or wallets");
    expect(feeRecipientOf("split")).toBe("holders or wallets");
    expect(feeRecipientOf("cashback")).toBe("holders or wallets");
    expect(feeRecipientOf("github")).toBe("GitHub");
    expect(feeRecipientOf("creator")).toBe("dev");
    expect(feeRecipientOf("unknown")).toBeNull();
    expect(feeRecipientOf(null)).toBeNull();
  });

  it("counts coins per group, biggest first, leaving out what TokenSage couldn't place", () => {
    expect(
      feeRecipientCounts([
        { label: "creator", count: 40n },
        { label: "holder_rewards", count: 5n },
        { label: "wallet", count: 3n },
        { label: "github", count: 2n },
        { label: "unknown", count: 9n },
        { label: null, count: 1n },
      ]),
    ).toEqual([
      { label: "dev", count: 40 },
      { label: "holders or wallets", count: 8 },
      { label: "GitHub", count: 2 },
    ]);
  });
});
