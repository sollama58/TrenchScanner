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
      logoDetail: null,
      title: "No creator reward is stored",
      empty: true,
      squareLabel: "Creator reward",
      otcDesk: false,
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
    expect(charity.value).toBe("Red Cross");
    expect(charity.detail).toBeNull();
    expect(charity.title).toBe("Creator fees go to Red Cross.");
    expect(charity.title).not.toBe("Creator fees go to charity.");
  });

  it("labels an OTC desk square and keeps the tooltip sentence", () => {
    const fee = {
      destination: "holder_rewards" as const,
      summary: null,
      bps: 100,
      deskLine: "OTC Desks pays holder rewards in NVDAx.",
      deskRewards: [{ label: "NVDAx", mint: NVDA, symbol: "NVDA" }],
    };
    const fig = creatorRewardFigure(fee);
    expect(fig.squareLabel).toBe("Holder Rewards: OTC Desks");
    expect(fig.otcDesk).toBe(true);
    expect(fig.value).toBe("$NVDA");
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
    expect(fig.value).toBe("OTC Desks");
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
    expect(html).toContain("OTC Desks");
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

  it("uses the empty dash when the destination is unknown and the gift is hidden", () => {
    expect(
      creatorRewardFigure({ destination: "unknown", summary: "fee split; recipients unreadable" }),
    ).toEqual({
      value: "–",
      detail: null,
      logoDetail: null,
      title: "Fee split; recipients unreadable.",
      empty: true,
      squareLabel: "Creator reward",
      otcDesk: false,
    });
    expect(creatorRewardFigure({ destination: "unknown", summary: null })).toEqual({
      value: "–",
      detail: null,
      logoDetail: null,
      title: "No creator reward is stored",
      empty: true,
      squareLabel: "Creator reward",
      otcDesk: false,
    });
    const fig = creatorRewardFigure({ destination: "unknown", summary: null });
    const html = renderToStaticMarkup(
      <span className={fig.empty ? "num none" : "num"} title={fig.title}>
        {fig.value}
      </span>,
    );
    expect(html).toContain("num none");
    expect(html).toContain("–");
    expect(html).not.toContain("Rewards");
  });

  it("keeps a holder tax, the dev, a charity, and an OTC line", () => {
    expect(creatorRewardFigure({ destination: "holder_rewards", summary: null, bps: 300 })).toMatchObject({
      value: "Holders 3%",
      empty: false,
    });
    expect(creatorRewardFigure({ destination: "creator", summary: null }).value).toBe("Dev");
    expect(
      creatorRewardFigure({ destination: "charity", summary: null, charityName: "Red Cross" }).value,
    ).toBe("Red Cross");
    const otc = creatorRewardFigure({
      destination: "unknown",
      summary: "fee split; recipients unreadable",
      deskLine,
      deskRewards: [
        { label: "NVDAx", mint: NVDA },
        { label: "TSLAx", mint: TSLA },
      ],
    });
    expect(otc.empty).toBe(false);
    expect(otc.value).not.toBe("–");
    expect(otc.title).toContain("NVDAx and TSLAx");
  });

  it("leaves the coin names off the line under the OTC logos, keeping the tax (user ask 2026-10-22)", () => {
    const fig = creatorRewardFigure({
      destination: "holder_rewards",
      summary: null,
      bps: 100,
      deskLine,
      deskRewards: [
        { label: "NVDAx", mint: NVDA },
        { label: "TSLAx", mint: TSLA },
        { label: "SPYx", mint: null },
      ],
    });
    expect(fig.otcDesk).toBe(true);
    expect(fig.logoDetail).toBe("1%");
    const wallet = creatorRewardFigure({
      destination: "wallet",
      summary: null,
      deskLine,
      deskRewards: [
        { label: "NVDAx", mint: NVDA },
        { label: "TSLAx", mint: TSLA },
      ],
    });
    expect(wallet.detail).toBe("NVDAx, TSLAx");
    expect(wallet.logoDetail).toBeNull();
  });

  it("copies the sage desk sentence and its coins from the same side", () => {
    const card = {
      token: {
        creatorFee: {
          destination: "wallet",
          summary: "creator fees go to a wallet",
          charityName: "Red Cross",
          bps: 300,
          deskLine: "OTC Desks pays holder rewards in NVDAx.",
          deskRewards: [{ label: "NVDAx", mint: NVDA }],
        },
      },
    } as unknown as Card;
    const rewards = [
      { label: "NVDAx", mint: NVDA },
      { label: "TSLAx", mint: TSLA },
    ];
    const next = cardWithOtcDesk(card, { feeDesk: deskLine, feeRewards: rewards });
    expect(next.token.creatorFee).toMatchObject({
      charityName: "Red Cross",
      bps: 300,
      deskLine,
      deskRewards: rewards,
    });
    const split = cardWithOtcDesk(card, {
      feeDesk: null,
      feeRewards: [{ label: "TSLAx", mint: TSLA }],
    });
    expect(split.token.creatorFee?.deskLine ?? null).toBeNull();
    expect(split.token.creatorFee?.deskRewards).toEqual([{ label: "TSLAx", mint: TSLA }]);
    expect(cardWithOtcDesk(card, null).token.creatorFee?.deskLine).toBe(
      "OTC Desks pays holder rewards in NVDAx.",
    );
  });

  it("puts a sage charity name on the card the square reads", () => {
    const card = {
      token: {
        creatorFee: { destination: "charity", summary: "creator fees go to charity" },
      },
    } as unknown as Card;
    const next = cardWithOtcDesk(card, {
      read: { creatorFee: { destination: "charity", charityName: "Red Cross" } },
    });
    expect(next.token.creatorFee?.charityName).toBe("Red Cross");
    expect(creatorRewardFigure(next.token.creatorFee).title).toBe("Creator fees go to Red Cross.");
    expect(creatorRewardFigure(next.token.creatorFee).title).not.toBe("Creator fees go to charity.");
  });
});
