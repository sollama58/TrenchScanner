import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FeeBadge } from "./components/AlertCard";
import { CreatorFeeRich } from "./components/FeeRewards";
import { creatorRewardFigure } from "./creatorReward";

const NVDA = "So11111111111111111111111111111111111111112";

const charity = {
  destination: "charity" as const,
  summary: "creator fees go to charity",
  recipients: [
    { label: "Red Cross", bps: 6000 },
    { label: "AbCd…wxyz", bps: 4000 },
  ],
};

const otc = {
  destination: "holder_rewards" as const,
  summary: null,
  bps: 100,
  deskLine: "OTC Desks pays holder rewards in NVDAx.",
  deskRewards: [{ label: "NVDAx", mint: NVDA }],
};

describe("charity and OTC rewards on every fee surface", () => {
  it("shows each charity and its percent on a token card and a Scope card", () => {
    const card = renderToStaticMarkup(<FeeBadge fee={charity} word />);
    const scope = renderToStaticMarkup(<FeeBadge fee={charity} icon={12} className="scope-fee" />);
    for (const html of [card, scope]) {
      expect(html).toContain("Red Cross 60%");
      expect(html).toContain("AbCd…wxyz 40%");
      expect(html).toContain("fee-caption");
    }
    expect(card).toContain("FEES");
    expect(scope).toContain("scope-fee");
    expect(scope).not.toContain("FEES");
  });

  it("shows the OTC reward token on the holder-reward badge instead of a blank gift", () => {
    const card = renderToStaticMarkup(<FeeBadge fee={otc} word />);
    const scope = renderToStaticMarkup(<FeeBadge fee={otc} className="scope-fee" />);
    for (const html of [card, scope]) {
      expect(html).toContain("NVDAx");
      expect(html).toContain("desk-reward-tokens");
      expect(html).toContain("1%");
    }
    const blank = {
      destination: "holder_rewards" as const,
      summary: null,
      deskRewards: [{ label: "", mint: NVDA }],
    };
    const named = renderToStaticMarkup(<FeeBadge fee={blank} word />);
    expect(named).toContain("So11…1112");
  });

  it("shows the same words on the pro screen Creator fee line and the reward square", () => {
    const charityLine = renderToStaticMarkup(
      <p>
        Creator fee: <CreatorFeeRich fee={charity} />
      </p>,
    );
    expect(charityLine).toContain("Creator fee:");
    expect(charityLine).toContain("Red Cross (60%)");
    expect(charityLine).toContain("AbCd…wxyz (40%)");
    expect(charityLine).not.toContain("Creator fees go to charity.");

    const otcLine = renderToStaticMarkup(
      <p>
        Creator fee: <CreatorFeeRich fee={otc} />
      </p>,
    );
    expect(otcLine).toContain("NVDAx");
    expect(otcLine).toContain("solscan.io/token/");

    const square = creatorRewardFigure(otc);
    const html = renderToStaticMarkup(
      <div>
        <label>Creator reward</label>
        <span title={square.title}>{square.value}</span>
        {square.detail && <small>{square.detail}</small>}
      </div>,
    );
    expect(square.value).toBe("NVDAx");
    expect(square.value).not.toBe("Holders");
    expect(square.value).not.toBe("–");
    expect(html).toContain("NVDAx");
    expect(square.detail).toBe("1%");

    const named = creatorRewardFigure(charity);
    expect(named.value).toContain("Red Cross 60%");
    expect(named.value).toContain("AbCd…wxyz 40%");
    expect(named.title).toContain("Red Cross (60%)");
    expect(named.title).toContain("AbCd…wxyz (40%)");
  });
});
