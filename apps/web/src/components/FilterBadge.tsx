import type { FilterIconId } from "../api";
import {
  BoltIcon,
  CrownIcon,
  FlameIcon,
  GemIcon,
  RadarIcon,
  RocketIcon,
  ShieldIcon,
  SlidersIcon,
  StarIcon,
  TargetIcon,
  TrophyIcon,
} from "./Icons";

const GLYPHS: Record<FilterIconId, (p: { size?: number }) => React.ReactElement> = {
  target: TargetIcon,
  flame: FlameIcon,
  bolt: BoltIcon,
  rocket: RocketIcon,
  star: StarIcon,
  gem: GemIcon,
  crown: CrownIcon,
  shield: ShieldIcon,
  trophy: TrophyIcon,
  radar: RadarIcon,
};

/** A filter's chosen icon; the sliders (the generic "your filter" mark) when it has none. */
export function FilterGlyph({ icon, size = 12 }: { icon: FilterIconId | null | undefined; size?: number }) {
  const Glyph = (icon && GLYPHS[icon]) || SlidersIcon;
  return <Glyph size={size} />;
}
