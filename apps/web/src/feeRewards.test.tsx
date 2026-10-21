import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { creatorFeeLine, feeBadge } from "./components/AlertCard";
import { CreatorFeeRich, DeskSentence } from "./components/FeeRewards";

const MINT = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";
const OTHER = "So11111111111111111111111111111111111111112";

describe("CreatorFeeRich", () => {
  it("renders one reward coin as that token", () => {
    const fee = {
      destination: null,
      summary: null,
      deskLine: "OTC Desks pays holder rewards in NVDAx.",
      deskRewards: [{ label: "NVDAx", mint: MINT }],
    };
    const html = renderToStaticMarkup(<CreatorFeeRich fee={fee} />);
    expect(html).toContain(`href="https://solscan.io/token/${MINT}"`);
    expect(html).toContain(">NVDAx<");
    expect(html.replace(/<[^>]+>/g, "")).toBe("OTC Desks pays holder rewards in NVDAx.");
    expect(creatorFeeLine(fee)).toBe("OTC Desks pays holder rewards in NVDAx.");
  });

  it("names both coins in a two-coin basket and links each mint", () => {
    const deskLine = "OTC Desks pays holder rewards in NVDAx and TSLAx.";
    const fee = {
      destination: "wallet",
      summary: "creator fees go to a wallet",
      deskLine,
      deskRewards: [
        { label: "NVDAx", mint: MINT },
        { label: "TSLAx", mint: OTHER },
      ],
    };
    const html = renderToStaticMarkup(<CreatorFeeRich fee={fee} />);
    expect(html.replace(/<[^>]+>/g, "")).toBe(
      "Creator fees go to a wallet. OTC Desks pays holder rewards in NVDAx and TSLAx.",
    );
    expect(html).toContain(`href="https://solscan.io/token/${MINT}"`);
    expect(html).toContain(`href="https://solscan.io/token/${OTHER}"`);
    expect(html).toContain('class="fee-reward"');
    expect(creatorFeeLine(fee)).toBe(
      "Creator fees go to a wallet. OTC Desks pays holder rewards in NVDAx and TSLAx.",
    );
    expect(feeBadge(fee)?.title).toBe(
      "Creator fees go to a wallet. OTC Desks pays holder rewards in NVDAx and TSLAx.",
    );
  });

  it("keeps the sentence when a reward mint is not a mint", () => {
    const html = renderToStaticMarkup(
      <DeskSentence
        line="OTC Desks pays holder rewards in NVDAx."
        rewards={[{ label: "NVDAx", mint: "not-a-mint" }]}
      />,
    );
    expect(html).toBe("OTC Desks pays holder rewards in NVDAx.");
  });
});
