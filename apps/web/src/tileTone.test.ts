import { describe, expect, it } from "vitest";
import { tileLook, tileTone, tileToneColor } from "./tileTone";

describe("tileTone", () => {
  it("runs from 0 at zero to 1 at the red bound, clamped past it", () => {
    expect(tileTone(0, 40)).toBe(0);
    expect(tileTone(20, 40)).toBe(0.5);
    expect(tileTone(40, 40)).toBe(1);
    expect(tileTone(65, 40)).toBe(1);
    expect(tileTone(-5, 40)).toBe(0);
  });

  it("flips for a tile where more is better", () => {
    expect(tileTone(300, 50, 300)).toBe(0);
    expect(tileTone(175, 50, 300)).toBe(0.5);
    expect(tileTone(20, 50, 300)).toBe(1);
    expect(tileTone(900, 50, 300)).toBe(0);
  });

  it("has no tone without a reading or a scale", () => {
    expect(tileTone(null, 40)).toBeNull();
    expect(tileTone(undefined, 40)).toBeNull();
    expect(tileTone(Number.NaN, 40)).toBeNull();
    expect(tileTone(5, 0)).toBeNull();
  });
});

describe("tileToneColor", () => {
  it("mixes lower to median, then median to upper", () => {
    expect(tileToneColor(0)).toBe(
      "color-mix(in oklab, var(--tile-mid, var(--warn)) 0%, var(--tile-low, var(--good)))",
    );
    expect(tileToneColor(0.25)).toBe(
      "color-mix(in oklab, var(--tile-mid, var(--warn)) 50%, var(--tile-low, var(--good)))",
    );
    expect(tileToneColor(0.5)).toBe(
      "color-mix(in oklab, var(--tile-mid, var(--warn)) 100%, var(--tile-low, var(--good)))",
    );
    expect(tileToneColor(0.75)).toBe(
      "color-mix(in oklab, var(--tile-high, var(--bad)) 50%, var(--tile-mid, var(--warn)))",
    );
    expect(tileToneColor(1)).toBe(
      "color-mix(in oklab, var(--tile-high, var(--bad)) 100%, var(--tile-mid, var(--warn)))",
    );
  });
});

describe("tileLook", () => {
  it("shades a tile with a reading when on", () => {
    expect(tileLook(true, 0.5, false).className).toBe("toned");
    expect(tileLook(true, 1, true).className).toBe("toned toned-max");
  });

  it("falls back to red-at-the-cut when off or unread", () => {
    expect(tileLook(false, 1, true)).toEqual({ className: "risky" });
    expect(tileLook(false, 0.3, false)).toEqual({});
    expect(tileLook(true, null, false)).toEqual({});
  });
});
