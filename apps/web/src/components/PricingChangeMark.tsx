import { PRICING_CHANGE_LABEL } from "../pricingChange";

/**
 * A change's dashed line on an SVG time chart ("Pricing Methods Changed", "Floor Lowered to $7k";
 * pricingChange.ts): from the plot's top to its baseline at `x`, labelled at the top on whichever
 * side has room.
 */
export function PricingChangeMark({
  x,
  top,
  bottom,
  width,
  label = PRICING_CHANGE_LABEL,
}: {
  x: number;
  top: number;
  bottom: number;
  width: number;
  label?: string;
}) {
  const flip = x > width - 150;
  return (
    <g className="pricing-change" aria-label={label}>
      <line x1={x} x2={x} y1={top} y2={bottom} />
      <text x={flip ? x - 5 : x + 5} y={top + 10} textAnchor={flip ? "end" : "start"}>
        {label}
      </text>
    </g>
  );
}
