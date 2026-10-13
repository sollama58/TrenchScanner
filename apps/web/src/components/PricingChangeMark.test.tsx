import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrendChart } from "./TrendChart";
import { MultiLines } from "./Charts";

const days = ["Oct 10", "Oct 11", "Oct 12", "Oct 13"];

describe("the pricing change marker", () => {
  it("draws a labelled dashed line on the Lighthouse trend chart, and none when off the axis", () => {
    const props = {
      labels: days.map((d) => ({ short: d, full: d })),
      series: [{ id: "a", label: "2x rate", unit: "pct" as const, slot: 1, values: [10, 12, 9, 11] }],
      kind: "line" as const,
    };
    const html = renderToStaticMarkup(<TrendChart {...props} pricingChange={2.67} />);
    expect(html).toContain('class="pricing-change"');
    expect(html).toContain("Pricing Methods Changed");
    expect(renderToStaticMarkup(<TrendChart {...props} />)).not.toContain("pricing-change");
  });

  it("draws it on the Models week lines", () => {
    const html = renderToStaticMarkup(
      <MultiLines
        labels={days}
        series={[{ key: "a", label: "Model", tone: "s1", values: [10, 12, 9, 11] }]}
        pricingChange={2.17}
      />,
    );
    expect(html).toContain("Pricing Methods Changed");
  });
});
