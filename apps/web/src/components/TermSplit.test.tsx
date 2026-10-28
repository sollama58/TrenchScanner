import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TermSplit } from "./TermSplit";

const split = (value: number | null) =>
  renderToStaticMarkup(
    <TermSplit
      axis="x"
      label="Column width"
      value={value}
      size={() => 360}
      min={320}
      max={900}
      onSize={() => undefined}
      onReset={() => undefined}
    />,
  );

describe("TermSplit", () => {
  it("always tells a screen reader where the focusable separator sits (audit 10-27 WB-19)", () => {
    expect(split(480)).toContain('aria-valuenow="480"');
    // The layout's own size: measured after mount, never missing before it.
    expect(split(null)).toMatch(/aria-valuenow="\d+"/);
    expect(split(null)).toContain('aria-valuemin="320"');
  });
});
