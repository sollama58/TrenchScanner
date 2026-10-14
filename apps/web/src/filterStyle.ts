import type { FilterIconId } from "./api";

/**
 * A saved filter's own card style: a color and an icon its owner picks on the Filters tab. On the
 * feed cards that filter raises they take the place of Customize's outline and accent colors; a
 * filter with neither keeps the Customize look.
 */

/** The colors the Filters tab offers (the API takes any #rrggbb; these read in dark and light). */
export const FILTER_COLORS: { hex: string; label: string }[] = [
  { hex: "#ef4444", label: "Red" },
  { hex: "#f97316", label: "Orange" },
  { hex: "#eab308", label: "Yellow" },
  { hex: "#84cc16", label: "Lime" },
  { hex: "#22c55e", label: "Green" },
  { hex: "#14b8a6", label: "Teal" },
  { hex: "#06b6d4", label: "Cyan" },
  { hex: "#3b82f6", label: "Blue" },
  { hex: "#8b5cf6", label: "Violet" },
  { hex: "#ec4899", label: "Pink" },
];

/** Mirrors FILTER_ICONS in apps/api/src/routes/filters.ts, in the order the picker shows them. */
export const FILTER_ICONS: { id: FilterIconId; label: string }[] = [
  { id: "target", label: "Target" },
  { id: "flame", label: "Flame" },
  { id: "bolt", label: "Bolt" },
  { id: "rocket", label: "Rocket" },
  { id: "star", label: "Star" },
  { id: "gem", label: "Gem" },
  { id: "crown", label: "Crown" },
  { id: "shield", label: "Shield" },
  { id: "trophy", label: "Trophy" },
  { id: "radar", label: "Radar" },
];

/**
 * The CSS variables a card from this filter sets on itself, overriding the grid's Customize
 * colors: the outline (until the alert resolves, if Customize recolors resolved cards) and the
 * accent. Empty when the filter has no color.
 */
export function filterCardStyle(color: string | null | undefined): Record<string, string> {
  if (!color) return {};
  return {
    "--card-outline": color,
    "--brand-a": color,
    "--brand-ink": `color-mix(in srgb, ${color} 65%, var(--ink))`,
    "--filter-color": color,
  };
}
