import { describe, expect, it } from "vitest";
import { deskRewardName, deskRewardTokenLabel, hasOtcDeskRewards } from "./deskRewardDisplay";

const MINT = "So11111111111111111111111111111111111111112";

describe("deskRewardDisplay", () => {
  it("names a reward from symbol, name, roster label, then mint", () => {
    expect(deskRewardName({ label: "NVDAx", mint: MINT, symbol: "NVDA" })).toBe("$NVDA");
    expect(deskRewardName({ label: "NVDAx", mint: MINT, name: "Nvidia Desk" })).toBe("Nvidia Desk");
    expect(deskRewardName({ label: "NVDAx", mint: MINT })).toBe("NVDAx");
    expect(deskRewardName({ label: "", mint: MINT })).toBe("So11…1112");
  });

  it("detects OTC desk rewards on a fee read", () => {
    expect(hasOtcDeskRewards({ deskRewards: [{ label: "NVDAx", mint: MINT }] })).toBe(true);
    expect(hasOtcDeskRewards({ deskLine: "OTC Desks pays holder rewards in NVDAx." })).toBe(true);
    expect(hasOtcDeskRewards(null)).toBe(false);
  });

  it("uses tokenLabel when a mint and symbol are known", () => {
    expect(deskRewardTokenLabel({ label: "NVDAx", mint: MINT, symbol: "NVDA" })).toBe("$NVDA");
  });
});
