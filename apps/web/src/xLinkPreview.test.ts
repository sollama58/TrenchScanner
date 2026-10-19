import { describe, expect, it } from "vitest";
import { isXLink } from "./components/XLinkPreview";
import { compactCount, placeCard } from "./components/XPreviewCard";

describe("X link previews", () => {
  it("asks only about https X links", () => {
    expect(isXLink("https://x.com/coin")).toBe(true);
    expect(isXLink("https://twitter.com/coin/status/1")).toBe(true);
    expect(isXLink("https://x.com/")).toBe(false);
    expect(isXLink("http://x.com/coin")).toBe(false);
    expect(isXLink("https://example.com/coin")).toBe(false);
    expect(isXLink(null)).toBe(false);
  });

  it("writes counts the way X does", () => {
    expect(compactCount(950)).toBe("950");
    expect(compactCount(1200)).toBe("1.2K");
    expect(compactCount(1000)).toBe("1K");
    expect(compactCount(45_600)).toBe("46K");
    expect(compactCount(12_537_032)).toBe("13M");
    expect(compactCount(2_400_000)).toBe("2.4M");
  });

  it("puts the card under the link, above it near the bottom, and inside the window", () => {
    const view = { width: 400, height: 800 };
    const card = { width: 320, height: 200 };
    expect(placeCard({ top: 100, bottom: 120, left: 40, width: 20 }, card, view)).toEqual({
      top: 128,
      left: 8,
      above: false,
    });
    expect(placeCard({ top: 700, bottom: 720, left: 380, width: 16 }, card, view)).toEqual({
      top: 492,
      left: 72,
      above: true,
    });
  });
});
