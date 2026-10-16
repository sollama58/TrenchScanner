import { describe, expect, it } from "vitest";
import { safeLink } from "./tokenProfile.js";

describe("safeLink", () => {
  it("keeps https links and builds handles into links", () => {
    expect(safeLink("https://x.com/coin", "x")).toBe("https://x.com/coin");
    expect(safeLink("@coindev", "x")).toBe("https://x.com/coindev");
    expect(safeLink("coin_chat", "telegram")).toBe("https://t.me/coin_chat");
    expect(safeLink("https://coin.fun/", "website")).toBe("https://coin.fun/");
  });
  it("drops anything that isn't https", () => {
    expect(safeLink("http://coin.fun", "website")).toBeNull();
    expect(safeLink("javascript:alert(1)", "website")).toBeNull();
    expect(safeLink("not a link", "website")).toBeNull();
    expect(safeLink(null, "x")).toBeNull();
    expect(safeLink("", "telegram")).toBeNull();
  });
});
