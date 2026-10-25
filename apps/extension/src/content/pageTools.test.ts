// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Toasts } from "./toasts";
import { findTabStrip, isTokenPage, pageMint } from "./tokenPage";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { token } from "../shared/testToken";
import { cleanTooltip, colorsOf, DEFAULT_COLORS } from "../shared/tooltip";

const A = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
const B = "So11111111111111111111111111111111111111112";
const call = (model: string, odds: number) => ({
  model,
  name: model,
  tier: "high",
  confidence: 70,
  calibratedPct: odds,
  at: new Date().toISOString(),
  mcapUsd: 5_000,
});

describe("a coin's page", () => {
  it("is told by its path, and its coin by the links naming it most", () => {
    expect(isTokenPage("axiom", `/meme/${A}`)).toBe(true);
    expect(isTokenPage("axiom", "/pulse")).toBe(false);
    expect(isTokenPage("terminal", `/trade/solana/${A}`)).toBe(true);
    document.body.innerHTML = `<a href="https://solscan.io/token/${A}">s</a><a href="https://pump.fun/coin/${A}">p</a>
      <a href="https://solscan.io/token/${B}">a trade of another coin</a>`;
    expect(pageMint(document, "axiom", `/meme/${B}`)).toBe(A);
    expect(pageMint(document, "gmgn", `/sol/token/ref_${B}`)).toBe(B);
  });

  it("finds the site's tab strip by its Top Traders tab", () => {
    document.body.innerHTML = `<div id="strip"><button>Trades</button><button>Holders (5)</button><button><span>Top Traders</span></button></div>`;
    expect(findTabStrip(document)?.id).toBe("strip");
    document.body.innerHTML = `<p>Top Traders</p>`;
    expect(findTabStrip(document)).toBeNull();
  });
});

describe("on-page alerts", () => {
  function toasts(over: object = {}) {
    const prefs = cleanTooltip({ toast: { enabled: true, ...over } });
    return new Toasts(
      "axiom",
      { alerts: async () => null, totals: async () => null },
      prefs,
      DEFAULT_SETTINGS,
    );
  }
  const shown = () => document.querySelectorAll("trench-overlay-toasts").length;

  it("are off unless turned on", () => {
    expect(cleanTooltip(null).toast.enabled).toBe(false);
  });

  it("take the feed already there as seen, and show only new alerts that pass", async () => {
    document.documentElement.querySelectorAll("trench-overlay-toasts").forEach((n) => n.remove());
    const t = toasts({ minOdds: 30 });
    t.receive([token({ mint: A, modelCalls: [call("first", 50)] })]);
    expect(shown()).toBe(0);
    t.receive([token({ mint: B, modelCalls: [call("weak", 10)] })]);
    await Promise.resolve();
    expect(shown()).toBe(0);
    t.receive([token({ mint: B, modelCalls: [call("strong", 60)] })]);
    await new Promise((r) => setTimeout(r, 0));
    expect(shown()).toBe(1);
  });
});

describe("colours", () => {
  it("take only plain hex, and fall back to the defaults", () => {
    const prefs = cleanTooltip({ colors: { model: "#123ABC", filter: "red;}body{x:y", risk: 5 } });
    expect(prefs.colors).toEqual({ model: "#123abc" });
    expect(colorsOf(prefs).filter).toBe(DEFAULT_COLORS.filter);
  });
});
