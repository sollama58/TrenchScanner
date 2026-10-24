// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { token } from "../shared/testToken";
import { verdictFor } from "../shared/verdict";
import { imageSources, siteUrl, tokenCard } from "./card";

const A = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
const call = {
  model: "m1",
  name: "Sniper v4",
  tier: "high",
  confidence: 74,
  calibratedPct: 41,
  at: new Date().toISOString(),
  mcapUsd: 4_000,
};

describe("panel cards", () => {
  it("links each enabled site's token page on fixed hosts", () => {
    expect(siteUrl("axiom", A)).toBe(`https://axiom.trade/t/${A}`);
    expect(siteUrl("terminal", A)).toBe(`https://trade.padre.gg/trade/solana/${A}`);
    expect(siteUrl("gmgn", A)).toBe(`https://gmgn.ai/sol/token/${A}`);

    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.sites.gmgn = false;
    const t = token({ modelCalls: [call] });
    const card = tokenCard(t, verdictFor(t, settings), settings);
    const hrefs = [...card.querySelectorAll("a")].map((a) => a.href);
    expect(hrefs).toEqual([
      `https://axiom.trade/t/${A}`,
      `https://trade.padre.gg/trade/solana/${A}`,
      `https://trenchscanner.app/?sage=${A}`,
    ]);
    for (const a of card.querySelectorAll("a")) expect(a.rel).toBe("noopener noreferrer");
    expect(card.className).toBe("card model");
    expect(card.textContent).toContain("Sniper v4 41%");
    // The name sits up top; the address is a copy button at the bottom right.
    expect(card.querySelector(".top .full")?.textContent).toBe("Ring Coin");
    expect(card.querySelector(".foot > .ca")?.textContent).toBe("6p6x…GiPN");
    // Alerted at $4K, now $5.1K: green.
    expect(card.querySelector(".line .r")?.className).toBe("r up");
  });

  it("copies the whole address and colours a fall red", async () => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (text: string) => ((copied = text), Promise.resolve()) },
      configurable: true,
    });
    const t = token({ modelCalls: [{ ...call, mcapUsd: 9_000 }] });
    const card = tokenCard(t, verdictFor(t, DEFAULT_SETTINGS), DEFAULT_SETTINGS);
    const ca = card.querySelector<HTMLButtonElement>(".ca")!;
    ca.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toBe(A);
    expect(ca.textContent).toBe("Copied");
    expect(card.querySelector(".line .r")?.className).toBe("r down");
  });

  it("loads images over https only, smallest first", () => {
    const pump = "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump";
    expect(imageSources(token({ image: null }), 64)).toEqual([]);
    expect(imageSources(token({ image: "http://x.test/a.png" }), 64)).toEqual([]);
    expect(imageSources(token({ image: "javascript:alert(1)" }), 64)).toEqual([]);
    expect(
      imageSources(token({ image: "https://cdn.dexscreener.com/cms/images/a?width=800&height=800" }), 64),
    ).toEqual([
      "https://cdn.dexscreener.com/cms/images/a?width=64&height=64&quality=80",
      "https://cdn.dexscreener.com/cms/images/a?width=800&height=800",
    ]);
    expect(imageSources(token({ mint: pump, image: null }), 64)).toEqual([
      `https://images.pump.fun/coin-image/${pump}?variant=64x64`,
    ]);
  });

  it("never parses token text as HTML, and gives a bad address no links", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const t = token({
      mint: "not a mint/../../evil",
      symbol: evil,
      filterMatches: [{ filterId: "f", filterName: evil, at: new Date().toISOString(), mcapUsd: null }],
      ai: { decision: "buy", probability2x: 0.6, reasoning: evil, at: new Date().toISOString() },
    });
    const card = tokenCard(t, verdictFor(t, DEFAULT_SETTINGS), DEFAULT_SETTINGS);
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelectorAll("a")).toHaveLength(0);
    expect(card.querySelector(".ca")).toBeNull();
    expect(card.textContent).toContain(evil);
  });
});
