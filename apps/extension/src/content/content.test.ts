// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { axiom, gmgn, terminal } from "./adapters/sites";
import { OverlayEngine } from "./engine";
import { tooltipBody } from "./ui";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { token } from "../shared/testToken";
import { verdictFor } from "../shared/verdict";

const A = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
const B = "So11111111111111111111111111111111111111112";
const call = {
  model: "rules",
  name: "Runner A",
  tier: "high",
  confidence: 74,
  calibratedPct: 74,
  at: new Date().toISOString(),
  mcapUsd: 6_100,
};

beforeAll(() => {
  class FakeIntersectionObserver {
    constructor(private readonly cb: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this as never);
    }
    unobserve() {}
    disconnect() {}
  }
  (globalThis as Record<string, unknown>).IntersectionObserver = FakeIntersectionObserver;
});

afterEach(() => {
  document.body.replaceChildren();
});

function board(html: string) {
  document.body.innerHTML = html;
}

describe("Axiom's Pulse", () => {
  it("reads the address its rows carry, and skips other chains' rows", () => {
    board(`<div role="row"><div class="relative" data-pulse-token-address="${A}"><a href="https://pump.fun/coin/${A}">pf</a></div></div>
      <div role="row"><div class="relative" data-pulse-token-address="0xf9777050d1f243bcf4acef2149ce685617017a50"></div></div>`);
    const rows = axiom.findRows(document);
    expect(rows.map((r) => axiom.mintOf(r))).toEqual([A, null]);
  });

  it("never reads an address out of a row's inline pictures, or makes a row of a list", () => {
    const png = "data:image/png;base64,5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1";
    board(`<div data-index="0"><a href="/t/${B}">t</a>
      <div role="row"><div data-pulse-token-address="0xab318e9a95f243bcf4acef2149ce685617017a50"><img src="${png}"></div></div></div>`);
    const rows = axiom.findRows(document);
    expect(rows.map((r) => axiom.mintOf(r))).toEqual([null]);
  });
});

describe("Trending boards", () => {
  it("Terminal: reads the copy button's address and never rings the quote pill's coin", () => {
    board(`<div style="position: absolute; top: 0px; height: 88px; width: 100%;">
      <button id="button-copy-address-context-${A}">copy</button>
      <a href="https://trade.padre.gg/trade/solana/${B}?tpo=quotePill">quote</a></div>`);
    const rows = terminal.findRows(document);
    expect(rows.map((r) => terminal.mintOf(r))).toEqual([A]);
  });

  it("Axiom Discover: reads the row's pump.fun link, not its quote token's chip", () => {
    board(`<div data-index="0"><div data-discover-icon-row="true">
      <span data-tooltip-trigger=""><a href="https://axiom.trade/t/${B}?chain=sol"><img alt="q"></a></span>
      <div><a href="https://pump.fun/coin/${A}">pf</a></div></div></div>
      <div data-index="1"><div data-discover-icon-row="true"><a href="https://otcdesks.cash/coin/${B}">otc</a></div></div>`);
    const rows = axiom.findRows(document);
    expect(rows.map((r) => axiom.mintOf(r))).toEqual([A, B]);
    expect(rows.map((r) => r.getAttribute("data-index"))).toEqual(["0", "1"]);
  });
});

describe("Terminal's Trenches board", () => {
  it("reads the address its rows are marked with, and rings the sized slot", () => {
    board(`<div style="position: absolute; left: 0px; top: 0px; height: 142px; width: 100%;">
      <span data-trenches-item="SOLANA:${A}-NEW"><a href="https://pump.fun/coin/${A}">pf</a></span></div>
      <div style="position: absolute; left: 0px; top: 142px; height: 142px; width: 100%;">
      <span data-trenches-item="SOLANA:${B}-NEW"></span></div>`);
    const rows = terminal.findRows(document);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tagName).toBe("DIV");
    expect(rows.map((r) => terminal.mintOf(r))).toEqual([A, B]);
  });
});

describe("site adapters", () => {
  it("reads GMGN rows, with or without a referral prefix", () => {
    board(
      `<div data-index="0"><a href="/sol/token/ref1_${A}">A</a></div><div data-index="1"><a href="/sol/token/${B}">B</a></div>`,
    );
    const rows = gmgn.findRows(document);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => gmgn.mintOf(r))).toEqual([A, B]);
  });

  it("reads Terminal rows and ignores links that aren't token pages", () => {
    board(
      `<div data-index="0"><a href="https://trade.padre.gg/trade/solana/${A}">A</a><a href="/trenches">x</a></div><div data-index="1"><a href="/profile/${B}">B</a></div>`,
    );
    const rows = terminal.findRows(document);
    expect(rows).toHaveLength(1);
    expect(terminal.mintOf(rows[0]!)).toBe(A);
  });

  it("reads Axiom's /t/ links, not /meme/ pool links", () => {
    board(
      `<div data-index="0"><a href="/t/${A}">A</a></div><div data-index="1"><a href="/meme/${B}">pool</a></div>`,
    );
    const rows = axiom.findRows(document);
    expect(rows.map((r) => axiom.mintOf(r))).toEqual([A]);
  });

  it("draws nothing for a block holding two different tokens", () => {
    board(`<section id="col"><a href="/sol/token/${A}">A</a><a href="/sol/token/${B}">B</a></section>`);
    expect(gmgn.mintOf(document.getElementById("col")!)).toBeNull();
  });

  it("falls back to an image or data attribute inside the row", () => {
    board(`<div id="r"><img src="https://cdn.example/${A}.png" /></div>`);
    expect(gmgn.mintOf(document.getElementById("r")!)).toBe(A);
  });
});

describe("tooltip", () => {
  it("never parses token text as HTML", () => {
    const evil = token({
      symbol: `<img src=x onerror="alert(1)">`,
      modelCalls: [{ ...call, name: `<script>alert(1)</script>` }],
      filterMatches: [
        { filterId: "f", filterName: `<b onmouseover=alert(1)>x</b>`, at: call.at, mcapUsd: null },
      ],
      ai: {
        decision: "buy",
        probability2x: 0.5,
        reasoning: `<iframe src="https://evil.example"></iframe>`,
        at: call.at,
      },
    });
    const body = tooltipBody(evil, verdictFor(evil, DEFAULT_SETTINGS));
    expect(body.querySelector("img, script, iframe, b")).toBeNull();
    expect(body.textContent).toContain("<script>alert(1)</script>");
    const link = body.querySelector("a")!;
    expect(link.href).toBe(`https://trenchscanner.app/?sage=${evil.mint}`);
    expect(link.rel).toContain("noopener");
  });
});

describe("overlay engine", () => {
  function engine(lookups: string[][] = []) {
    const reports: { rows: number; mints: number; paused: boolean }[] = [];
    const e = new OverlayEngine(gmgn, DEFAULT_SETTINGS, {
      lookup: async (mints) => {
        lookups.push(mints);
        return { tokens: {}, problem: null };
      },
      report: (h) => reports.push(h),
    });
    return { e, reports };
  }
  const overlayIn = (row: Element) => row.querySelector("trench-overlay");

  it("draws on a tracked row and clears it when the row is recycled for another token", () => {
    board(`<div id="r" data-index="0"><a href="/sol/token/${A}">A</a></div>`);
    const { e } = engine();
    e.start();
    e.scan();
    const row = document.getElementById("r")!;
    e.receive([A], { tokens: { [A]: token({ mint: A, modelCalls: [call] }) }, problem: null });
    expect(overlayIn(row)).not.toBeNull();
    expect(row.style.position).toBe("relative");

    // The virtual list reuses the row for another coin.
    row.querySelector("a")!.setAttribute("href", `/sol/token/${B}`);
    e.scan();
    expect(overlayIn(row)).toBeNull();
    expect(row.style.position).toBe("");
    e.stop();
  });

  it("leaves untracked and unalerted rows alone", () => {
    board(`<div id="r" data-index="0"><a href="/sol/token/${A}">A</a></div>`);
    const { e } = engine();
    e.start();
    e.scan();
    e.receive([A], { tokens: {}, problem: null });
    expect(overlayIn(document.getElementById("r")!)).toBeNull();
    e.receive([A], { tokens: { [A]: token({ mint: A }) }, problem: null });
    expect(overlayIn(document.getElementById("r")!)).toBeNull();
    e.stop();
  });

  it("pauses when rows show up but no address can be read for 10 seconds, and resumes", () => {
    // One row holding two different tokens: the adapter refuses to name either.
    board(`<div data-index="0"><a href="/sol/token/${A}">A</a><a href="/sol/token/${B}">B</a></div>`);
    const { e, reports } = engine();
    e.start();
    e.scan(0);
    expect(reports.at(-1)).toEqual({ rows: 1, mints: 0, paused: false });
    e.scan(10_000);
    expect(reports.at(-1)?.paused).toBe(true);
    board(`<div data-index="0"><a href="/sol/token/${A}">A</a></div>`);
    e.scan(11_000);
    expect(reports.at(-1)).toEqual({ rows: 1, mints: 1, paused: false });
    e.stop();
  });
});
