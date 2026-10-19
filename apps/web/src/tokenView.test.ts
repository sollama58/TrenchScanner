import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, defaultLook, normalizeAppearance, withPreset } from "./appearance";

describe("the token window's desktop layout", () => {
  it("opens in Pro unless Classic is picked (user ask 2026-10-19)", () => {
    expect(DEFAULT_APPEARANCE.tokenView).toBe("pro");
    expect(normalizeAppearance({}).tokenView).toBe("pro");
    expect(normalizeAppearance({ tokenView: "classic" }).tokenView).toBe("classic");
    expect(normalizeAppearance({ tokenView: "terminal" }).tokenView).toBe("pro");
  });

  it("keeps the reader's pick through a preset and the default look", () => {
    const classic = normalizeAppearance({ tokenView: "classic" });
    expect(withPreset(classic, {}).tokenView).toBe("classic");
    expect(defaultLook(classic).tokenView).toBe("classic");
  });
});
