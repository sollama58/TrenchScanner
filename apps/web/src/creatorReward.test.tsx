import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Card } from "./api";
import { feeBadge } from "./components/AlertCard";
import { cardWithOtcDesk, creatorRewardFigure } from "./creatorReward";

const NVDA = "So11111111111111111111111111111111111111112";
const TSLA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const deskLine = "OTC Desks pays holder rewards in NVDAx and TSLAx.";

describe("creator reward square", () => {
  it("is empty the same way a missing detection cap is empty", () => {
    expect(creatorRewardFigure(null)).toEqual({
      value: "–",
      detail: null,
      title: "No creator reward is stored",
      empty: true,
    });
    expect(creatorRewardFigure({ destination: null, summary: null })).toMatchObject({
      empty: true,
      value: "–",
    });
  });

  it("shows holder rewards with the tax, and the dev, and a charity by name", () => {
    expect(creatorRewardFigure({ destination: "holder_rewards", summary: null, bps: 100 })).toMatchObject({
      value: "Holders 1%",
      empty: false,
    });
    expect(creatorRewardFigure({ destination: "creator", summary: null })).toMatchObject({
      value: "Dev",
      title: "Creator fees go to the dev.",
    });
    const charity = creatorRewardFigure({
      destination: "charity",
      summary: "creator fees go to charity",
      charityName: "Red Cross",
    });
    expect(charity.value).toBe("Charity");
    expect(charity.detail).toBe("Red Cross");
    expect(charity.title).toContain("Red Cross");
  });

  it("shows a matched OTC basket in the square and in the tooltip", () => {
    const fee = {
      destination: "wallet" as const,
      summary: "creator fees go to a wallet",
      deskLine,
      deskRewards: [
        { label: "NVDAx", mint: NVDA },
        { label: "TSLAx", mint: TSLA },
      ],
    };
    const fig = creatorRewardFigure(fee);
    expect(fig.value).toBe("Wallet");
    expect(fig.detail).toContain("NVDAx");
    expect(fig.detail).toContain("TSLAx");
    expect(fig.title).toBe(deskLine ? feeBadge(fee)?.title : null);
    expect(fig.title).toContain("NVDAx");
    expect(fig.title).toContain("TSLAx");
    expect(fig.empty).toBe(false);
    const html = renderToStaticMarkup(
      <div className="tm-fig">
        <label>Creator reward</label>
        <span className="num" title={fig.title}>
          {fig.value}
        </span>
        {fig.detail && <small className="num muted">{fig.detail}</small>}
      </div>,
    );
    expect(html).toContain("Creator reward");
    expect(html).toContain("Wallet");
    expect(html).toContain("NVDAx, TSLAx");
    expect(html).toContain("OTC Desks pays holder rewards in NVDAx and TSLAx.");
  });

  it("uses the sage desk line when the feed card was built without it", () => {
    const card = {
      token: { creatorFee: { destination: "wallet", summary: "creator fees go to a wallet" } },
    } as unknown as Card;
    const next = cardWithOtcDesk(card, {
      feeDesk: deskLine,
      feeRewards: [
        { label: "NVDAx", mint: NVDA },
        { label: "TSLAx", mint: TSLA },
      ],
    });
    const fig = creatorRewardFigure(next.token.creatorFee);
    expect(fig.detail).toContain("NVDAx");
    expect(fig.title).toContain("TSLAx");
    expect(feeBadge(next.token.creatorFee)?.title).toContain("NVDAx and TSLAx");
  });
});
