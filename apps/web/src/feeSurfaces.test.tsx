import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { charityTipRows, FeeBadge } from "./components/AlertCard";
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
      // One pill; the shares are in its tooltip (user ask 2026-10-23).
      expect(html).toContain("charity-pill");
      expect(html).toContain('aria-label="Creator fees go to Red Cross (60%) and AbCd…wxyz (40%)."');
      expect(html).not.toContain("fee-caption");
    }
    expect(charityTipRows(charity).map((r) => r.label)).toEqual(["Red Cross", "AbCd…wxyz"]);
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

describe("charity names from donate.gg (user ask 2026-10-23)", () => {
  const one = {
    destination: "charity" as const,
    summary: "creator fees go to charity",
    charityName: "St. Jude Children's Research Hospital",
    recipients: [
      { label: "8PQx…VP9z", bps: 100 },
      { label: "St. Jude Children's Research Hospital", bps: 9900, charity: true },
    ],
  };
  const two = {
    destination: "charity" as const,
    summary: "creator fees go to charity",
    recipients: [
      { label: "Pandas International", bps: 6000, charity: true },
      { label: "St. Jude Children's Research Hospital", bps: 4000, charity: true },
    ],
  };

  it("names the one charity in its own pill, with the split in the tooltip", () => {
    const card = renderToStaticMarkup(<FeeBadge fee={one} word />);
    expect(card).toContain("FEES");
    expect(card).toContain('<span class="charity-heart" aria-hidden="true">❤️</span>');
    expect(card).toContain('<span class="charity-name">St. Jude Children&#x27;s Research Hospital</span>');
    expect(card).not.toContain("charity-more");
    expect(card).not.toContain(">8PQx…VP9z");
    expect(card).toContain("8PQx…VP9z (1%)");
    // The charity leads the tooltip, then the other wallet the fee pays.
    expect(charityTipRows(one).map((r) => r.label)).toEqual([
      "St. Jude Children's Research Hospital",
      "8PQx…VP9z",
    ]);
    const square = creatorRewardFigure(one);
    expect(square.value).toBe("St. Jude Children's Research Hospital");
    expect(square.title).toBe(
      "Creator fees go to 8PQx…VP9z (1%) and St. Jude Children's Research Hospital (99%).",
    );
  });

  it("shows the first of several charities and +N, and lists each with its split in the tooltip", () => {
    const card = renderToStaticMarkup(<FeeBadge fee={two} word />);
    const scope = renderToStaticMarkup(<FeeBadge fee={two} icon={12} className="scope-fee" />);
    for (const html of [card, scope]) {
      expect(html).toContain('<span class="charity-name">Pandas International</span>');
      expect(html).toContain('<span class="charity-more">+1</span>');
      expect(html).toContain(
        'aria-label="Creator fees go to Pandas International (60%) and St. Jude Children&#x27;s Research Hospital (40%)."',
      );
    }
    expect(scope).toContain("scope-fee");
    expect(charityTipRows(two).every((r) => r.charity)).toBe(true);
    const square = creatorRewardFigure(two);
    expect(square.value).toBe("Pandas International +1");
    expect(square.detail).toBe("2 charities");
    expect(square.title).toContain("Pandas International (60%)");
    expect(square.title).toContain("St. Jude Children's Research Hospital (40%)");
  });
});
