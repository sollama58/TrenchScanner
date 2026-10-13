import { describe, expect, it } from "vitest";
import { screenReasonLabel } from "./screenReasons.js";

describe("screenReasonLabel", () => {
  it("drops the measured figures and keeps the cutoff", () => {
    expect(screenReasonLabel("82% of top-10 holders are fresh wallets (over 70%)")).toBe(
      "N% of top-10 holders are fresh wallets (over 70%)",
    );
    expect(screenReasonLabel("top-10 holders own 45% of supply (40% or more)")).toBe(
      "top-10 holders own N% of supply (40% or more)",
    );
    expect(screenReasonLabel("16 of the 20 top holders are linked (15 or more)")).toBe(
      "N of the N top holders are linked (15 or more)",
    );
    expect(screenReasonLabel("bonding curve filled 3s after launch (under 5s)")).toBe(
      "bonding curve filled Ns after launch (under 5s)",
    );
  });

  it("leaves reasons without figures alone", () => {
    expect(screenReasonLabel("on-chain profile unavailable - failing closed")).toBe(
      "on-chain profile unavailable - failing closed",
    );
  });
});
