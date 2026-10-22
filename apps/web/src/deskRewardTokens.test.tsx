import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeskRewardTokens } from "./components/DeskRewardTokens";

const MINT = "So11111111111111111111111111111111111111112";
const TSLA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const THIRD = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

describe("DeskRewardTokens", () => {
  it("shows the first two rewards and a + menu for the rest", () => {
    const html = renderToStaticMarkup(
      <DeskRewardTokens
        compact
        rewards={[
          { label: "NVDAx", mint: MINT, symbol: "NVDA" },
          { label: "TSLAx", mint: TSLA, symbol: "TSLA" },
          { label: "COIN3", mint: THIRD },
        ]}
      />,
    );
    expect(html).toContain("$NVDA");
    expect(html).toContain("$TSLA");
    expect(html).toContain("+1");
    expect(html).toContain("desk-reward-more-menu");
    expect(html).toContain("COIN3");
  });
});
