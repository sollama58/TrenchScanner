// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { token } from "../shared/testToken";
import { verdictFor } from "../shared/verdict";
import { siteUrl, tokenCard } from "./card";

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
    expect(card.textContent).toContain(evil);
  });
});
