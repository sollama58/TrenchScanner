// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { holderTags } from "../shared/holders";
import { HolderMarks, holderNamed } from "./holderMarks";
import { Toasts } from "./toasts";
import { findTabStrip, isTokenPage, pageMint } from "./tokenPage";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { token } from "../shared/testToken";
import { cleanTooltip, colorsOf, DEFAULT_COLORS, lighter, signalLook } from "../shared/tooltip";

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

  it("toast a coin once, however many models and filters call it", () => {
    const t = toasts();
    const show = vi.spyOn(t as unknown as { show: () => Promise<void> }, "show").mockResolvedValue();
    t.receive([token({ mint: A, modelCalls: [call("old", 50)] })]);
    t.receive([
      token({ mint: A, modelCalls: [call("old", 50), call("later", 70)] }),
      token({ mint: B, modelCalls: [call("one", 40), call("two", 60)] }),
    ]);
    expect(show).toHaveBeenCalledTimes(1);
    t.receive([token({ mint: B, modelCalls: [call("one", 40), call("two", 60), call("three", 80)] })]);
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe("colours", () => {
  it("take only plain hex, and fall back to the defaults", () => {
    const prefs = cleanTooltip({ colors: { model: "#123ABC", filter: "red;}body{x:y", risk: 5 } });
    expect(prefs.colors).toEqual({ model: "#123abc" });
    expect(colorsOf(prefs).filter).toBe(DEFAULT_COLORS.filter);
  });
});

describe("holder markers", () => {
  const W1 = "2Q3jYQWWzkfZotYMyxzAFwfpFT5RhhBvGS3mk8P7PryF";
  const W2 = "bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa";
  const map = {
    mint: A,
    symbol: "RING",
    readAt: null,
    scanAt: null,
    top50: true,
    holders: [
      {
        wallet: W1,
        pct: 4.2,
        cluster: 0,
        sameTime: null,
        trait: "sniper" as const,
        cex: false,
        creatorTied: true,
      },
      { wallet: W2, pct: 1.1, cluster: null, sameTime: null, trait: null, cex: false, creatorTied: false },
    ],
    clusters: [{ funder: B, pct: 6, count: 3, creatorLinked: true }],
    sameTime: [],
    totals: {} as never,
  };

  it("names a holder by its full address or a short form only it fits", () => {
    const holders = new Map(map.holders.map((h) => [h.wallet, h]));
    expect(holderNamed(W1, holders)).toBe(W1);
    expect(holderNamed("2Q3j…PryF", holders)).toBe(W1);
    expect(holderNamed("2Q3jY...7PryF", holders)).toBe(W1);
    expect(holderNamed("zzzz…PryF", holders)).toBeNull();
    expect(holderTags(map.holders[0]!, map, DEFAULT_COLORS).map((t) => t.text)).toEqual([
      "C1",
      "SNPR",
      "DEV",
    ]);
    expect(holderTags(map.holders[1]!, map, DEFAULT_COLORS)).toEqual([]);
  });

  it("marks the page's holders the map knows of, opens the map from a marker, and goes when turned off", async () => {
    vi.useFakeTimers();
    history.pushState({}, "", `/sol/token/${A}`);
    document.body.innerHTML = `<div class="holders">
      <div class="row"><a id="w1" href="https://solscan.io/account/${W1}">2Q3j…PryF</a><span>4.2%</span></div>
      <div class="row"><span id="w2">bwam…fSXa</span><span>1.1%</span></div></div>`;
    const openMap = vi.fn();
    const marks = new HolderMarks("gmgn", cleanTooltip({}), { holders: async () => map, openMap });
    marks.start();
    await vi.advanceTimersByTimeAsync(700);
    const chip = document.getElementById("w1")!.nextElementSibling!;
    expect(chip.tagName).toBe("TRENCH-OVERLAY-HOLDER");
    // A plain holder gets nothing.
    expect(document.getElementById("w2")!.nextElementSibling?.tagName).toBe("SPAN");
    expect(document.querySelectorAll("trench-overlay-holder")).toHaveLength(1);
    marks.applyPrefs(cleanTooltip({ holderMarks: { enabled: false } }));
    await vi.advanceTimersByTimeAsync(700);
    expect(document.querySelectorAll("trench-overlay-holder")).toHaveLength(0);
    marks.stop();
    expect(openMap).not.toHaveBeenCalled();
    history.pushState({}, "", "/");
    vi.useRealTimers();
  });
});

describe("each model's and filter's own ring", () => {
  it("takes the picked colour and effect over the kind's, the model's first", () => {
    const prefs = cleanTooltip({
      signals: {
        "model:rules": { color: "#112233", effect: "pulse", name: "Rules" },
        "filter:f1": { color: "#445566", effect: "sparkle" },
        "filter:bad key!": { color: "#000000" },
        "model:x": { effect: "explode" },
      },
    });
    expect(Object.keys(prefs.signals).sort()).toEqual(["filter:f1", "model:rules"]);
    const both = signalLook(prefs, "rules", "f1");
    expect(both.colors.model).toBe("#112233");
    expect(both.colors.filter).toBe("#445566");
    expect(both.effect).toBe("pulse");
    expect(signalLook(prefs, null, "f1").effect).toBe("sparkle");
    const plain = signalLook(prefs, "other", null);
    expect(plain.colors.model).toBe(DEFAULT_COLORS.model);
    expect(plain.effect).toBe("none");
    expect(lighter("#000000")).toBe("#737373");
  });
});
