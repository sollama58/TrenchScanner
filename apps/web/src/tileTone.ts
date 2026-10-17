import type { CSSProperties } from "react";

/**
 * The stat tiles' color scale (user ask 2026-10-16): each tile shades from the lower color, through
 * the median color halfway, to the upper color at its red bound, which is the safety screen's
 * cutoff where the tile has one. Customize picks the three colors (FeedAppearance.tileLow, tileMid,
 * tileHigh; the theme's win, amber and loss colors by default). It is off by default (tileColors).
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
 * How the tiles take the scale: "text" colors only the reading (the default, user ask 2026-10-16),
 * "box" shades the whole tile too (Customize's "Color the whole tile"), "off" leaves them plain.
 */
export type TileMode = "off" | "text" | "box";

/** The mode a look asks for. */
export function tileMode(look: { tileColors: boolean; tileFill: boolean }): TileMode {
  return !look.tileColors ? "off" : look.tileFill ? "box" : "text";
}

/**
 * A tile's class and style: colored on the scale when coloring is on and the tile has a reading,
 * else the plain tile, red only when the reading fails the screen (`risky`), as before.
 */
export function tileLook(
  mode: TileMode,
  tone: number | null,
  risky: boolean,
): { className?: string; style?: CSSProperties } {
  if (mode === "off" || tone === null) return risky ? { className: "risky" } : {};
  return {
    className: mode === "box" ? (risky ? "toned toned-box toned-max" : "toned toned-box") : "toned",
    style: { "--tile-c": tileToneColor(tone) } as CSSProperties,
  };
}

/** The red bounds of the tiles without a safety screen cut (user picks 2026-10-16). */
export const TILE_RED_KOL_BUNDLED_PCT = 30;
/** Transferred Supply %: red once a tenth of supply moved holder to holder (user ask 2026-10-16). */
export const TILE_RED_TRANSFERRED_PCT = 10;
export const TILE_RED_FIRST_BUYERS = 20;
/** The first-buyers count the bound is set on; a launch read over fewer scales it the same way. */
export const TILE_FIRST_BUYERS_OF = 25;
