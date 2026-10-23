import { describe, expect, it } from "vitest";
import { hoverOpens } from "./MarketBar";

describe("the trench stats card on hover", () => {
  it("opens for a mouse only, so a second tap on a phone closes it (WB-9)", () => {
    expect(hoverOpens("mouse")).toBe(true);
    expect(hoverOpens("touch")).toBe(false);
    expect(hoverOpens("pen")).toBe(false);
  });
});
