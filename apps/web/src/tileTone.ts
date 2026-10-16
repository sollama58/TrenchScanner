import type { CSSProperties } from "react";

/**
 * The stat tiles' color scale (user ask 2026-10-16): each tile shades from the lower color, through
 * the median color halfway, to the upper color at its red bound, which is the safety screen's
 * cutoff where the tile has one. Customize picks the three colors (FeedAppearance.tileLow, tileMid,
 * tileHigh; the theme's win, amber and loss colors by default) and can switch it off (tileColors).
 */

/**
 * Where a reading sits on its tile's scale: 0 at `green`, 1 at `red` and beyond, clamped. `red`
 * below `green` flips the scale, for a tile where more is better. Null without a reading.
 */
export function tileTone(value: number | null | undefined, red: number, green = 0): number | null {
  if (value == null || !Number.isFinite(value) || red === green) return null;
  return Math.min(1, Math.max(0, (value - green) / (red - green)));
}

/** The tone as a CSS color: lower to median over the first half, median to upper over the second. */
export function tileToneColor(tone: number): string {
  const t = Math.min(1, Math.max(0, tone));
  return t <= 0.5
    ? `color-mix(in oklab, var(--tile-mid, var(--warn)) ${Math.round(t * 200)}%, var(--tile-low, var(--good)))`
    : `color-mix(in oklab, var(--tile-high, var(--bad)) ${Math.round((t - 0.5) * 200)}%, var(--tile-mid, var(--warn)))`;
}

/**
 * A tile's class and style: shaded on the scale when coloring is on and the tile has a reading,
 * else the plain tile, red only when the reading fails the screen (`risky`), as before.
 */
export function tileLook(
  on: boolean,
  tone: number | null,
  risky: boolean,
): { className?: string; style?: CSSProperties } {
  if (!on || tone === null) return risky ? { className: "risky" } : {};
  return {
    className: risky ? "toned toned-max" : "toned",
    style: { "--tile-c": tileToneColor(tone) } as CSSProperties,
  };
}
