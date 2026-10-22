import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DeskRewardTokens,
  deskRewardAria,
  deskRewardFullName,
  deskRewardMonogram,
} from "./components/DeskRewardTokens";

const MINT = "So11111111111111111111111111111111111111112";
const TSLA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const THIRD = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const FOURTH = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFu3m3YW8pZKYZhA";

const FOUR = [
  {
    label: "NVDAx",
    mint: MINT,
    symbol: "NVDAx",
    name: "NVIDIA xStock",
    imageUrl: "https://img.example/nvda.png",
  },
  { label: "TSLAx", mint: TSLA, symbol: "TSLAx", name: "Tesla xStock" },
  { label: "SPYx", mint: THIRD, symbol: "SPYx" },
  { label: "COINx", mint: FOURTH, symbol: "COINx", name: "Coinbase xStock" },
];

describe("DeskRewardTokens", () => {
  it("shows logos only, the first three on a card, then a +N naming the rest (user ask 2026-10-22)", () => {
    const html = renderToStaticMarkup(<DeskRewardTokens compact rewards={FOUR} />);
    expect(html.match(/class="desk-reward-coin"/g)).toHaveLength(3);
    expect(html).toContain(">+1</button>");
    expect(html).toContain('aria-label="1 more: $COINx"');
    // The ticker and name are the coin's accessible name, not text beside it.
    expect(html).toContain('aria-label="$NVDAx, NVIDIA xStock"');
    expect(html).not.toContain(">$NVDAx<");
    expect(html).not.toContain("desk-reward-name");
    // Nothing opens until hovered, focused or tapped.
    expect(html).not.toContain("desk-reward-tip");
  });

  it("is a focusable button per coin, and hides the fee badge's own title over it", () => {
    const html = renderToStaticMarkup(<DeskRewardTokens compact rewards={FOUR.slice(0, 1)} />);
    expect(html).toContain('<button class="desk-reward-coin" type="button" title=""');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="group" aria-label="OTC Desks reward tokens"');
  });

  it("shows every coin in the pro token square", () => {
    const html = renderToStaticMarkup(<DeskRewardTokens rewards={FOUR} className="tm-desk-rewards" />);
    expect(html.match(/class="desk-reward-coin"/g)).toHaveLength(4);
    expect(html).not.toContain("desk-reward-more");
    expect(html).toContain("desk-reward-tokens tm-desk-rewards");
  });

  it("draws the logo when there is one and a monogram when there isn't", () => {
    const html = renderToStaticMarkup(<DeskRewardTokens compact rewards={FOUR.slice(0, 2)} />);
    expect(html).toMatch(/<img class="desk-reward-avatar"[^>]*src="[^"]*nvda/);
    expect(html).toContain('class="desk-reward-avatar placeholder"');
    expect(html).toContain(">T</span>");
  });

  it("names a coin by ticker, then its full name when that says more", () => {
    expect(deskRewardAria({ label: "NVDAx", mint: MINT, symbol: "NVDAx", name: "NVIDIA xStock" })).toBe(
      "$NVDAx, NVIDIA xStock",
    );
    expect(deskRewardFullName({ label: "SPYx", mint: THIRD, symbol: "SPYx", name: "spyx" })).toBeNull();
    expect(deskRewardAria({ label: "COIN3", mint: null })).toBe("COIN3");
    expect(deskRewardMonogram({ label: "NVDAx", mint: MINT, symbol: "$nvdax" })).toBe("NV");
    expect(deskRewardMonogram({ label: "", mint: null })).toBe("RE");
  });
});
