import { PRICING_CHANGE_LABEL } from "../pricingChange";

/**
 * The dashed "Pricing Methods Changed" line on an SVG time chart (pricingChange.ts): from the
 * plot's top to its baseline at `x`, labelled at the top on whichever side has room.
 */
export function PricingChangeMark({
  x,
  top,
  bottom,
  width,
}: {
  x: number;
  top: number;
  bottom: number;
  width: number;
}) {
  const flip = x > width - 150;
  return (
    <g className="pricing-change" aria-label={PRICING_CHANGE_LABEL}>
      <line x1={x} x2={x} y1={top} y2={bottom} />
      <text x={flip ? x - 5 : x + 5} y={top + 10} textAnchor={flip ? "end" : "start"}>
        {PRICING_CHANGE_LABEL}
      </text>
    </g>
  );
}
