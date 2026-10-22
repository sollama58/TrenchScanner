import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { feeBadge } from "./components/AlertCard";
import { FeeCard, sageFeeIntro } from "./components/SageView";

const name = "St. Jude Children's Research Hospital";

describe("TokenSage fee card", () => {
  it("shows the Pump.fun charity name and leaves the heart tooltip as it was", () => {
    const fee = {
      destination: "charity",
      mechanism: null,
      summary: "creator fees go to charity",
      mutable: null,
      shares: [],
      recipients: [],
      charityName: name,
    };
    expect(sageFeeIntro(fee)).toBe(`${name}. Creator fees go to charity.`);
    const html = renderToStaticMarkup(<FeeCard fee={fee} />);
    expect(html).toContain("St. Jude Children");
    expect(html).toContain("Research Hospital");
    expect(html).toContain("Creator fees go to charity.");
    // The heart's tooltip is the same sentence. This card does not replace that rule.
    expect(
      feeBadge({ destination: "charity", summary: "creator fees go to charity.", charityName: name })?.title,
    ).toBe(`${name}. Creator fees go to charity.`);
    expect(sageFeeIntro({ ...fee, charityName: null })).toBe("Creator fees go to charity.");
    expect(
      sageFeeIntro({ destination: "creator", summary: "creator fees go to the dev", charityName: name }),
    ).toBe("Creator fees go to the dev.");
    const plain = renderToStaticMarkup(<FeeCard fee={{ ...fee, charityName: undefined }} />);
    expect(plain).toContain("Creator fees go to charity.");
    expect(plain).not.toContain("St. Jude");
  });
});
