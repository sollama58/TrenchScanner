// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { axiom, gmgn, terminal } from "./adapters/sites";
import { columnOf, findColumns } from "./columns";
import { Scoper } from "./scope";
import { OverlayEngine, structural } from "./engine";
import { safetyBody, tooltipBody } from "./ui";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { cleanTooltip } from "../shared/tooltip";
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
    expect(link.href).toBe(`https://trenchscanner.app/?token=${evil.mint}`);
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

  it("prunes old lookup answers past 5,000 coins, keeping the ones still on a row (audit EX-9)", () => {
    board(`<div id="r" data-index="0"><a href="/sol/token/${A}">A</a></div>`);
    const { e } = engine();
    e.start();
    e.scan();
    const t0 = 1_000_000;
    e.receive([A], { tokens: { [A]: token({ mint: A, modelCalls: [call] }) }, problem: null }, t0);
    const old = Array.from({ length: 5_000 }, (_, i) => `old${i}`);
    e.receive(old, { tokens: {}, problem: null }, t0);
    expect(e.answerCount).toBe(5_001);
    // Five minutes on, one more coin scrolls past: everything older than 150 s and off the board goes.
    e.receive([B], { tokens: {}, problem: null }, t0 + 300_000);
    expect(e.answerCount).toBe(2);
    expect(overlayIn(document.getElementById("r")!)).not.toBeNull();
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

  it("draws a ring again when the site's renderer takes it away, and scans on rows, not on ticking text", () => {
    board(`<div id="r" data-index="0"><a href="/sol/token/${A}">A</a><span id="mc">$5K</span></div>`);
    const { e } = engine();
    e.start();
    e.scan();
    const row = document.getElementById("r")!;
    e.receive([A], { tokens: { [A]: token({ mint: A, modelCalls: [call] }) }, problem: null });
    overlayIn(row)!.remove();
    e.scan();
    expect(overlayIn(row)).not.toBeNull();
    e.stop();

    const records = (target: Node, mutate: () => void) => {
      const seen: MutationRecord[] = [];
      const watch = new MutationObserver((r) => seen.push(...r));
      watch.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: gmgn.watchedAttributes,
      });
      mutate();
      seen.push(...watch.takeRecords());
      watch.disconnect();
      return seen;
    };
    const mc = document.getElementById("mc")!;
    // A price ticking over, either way a renderer writes it: no scan.
    expect(structural(records(mc, () => (mc.textContent = "$6K")))).toBe(false);
    expect(structural(records(mc, () => ((mc.firstChild as Text).data = "$7K")))).toBe(false);
    // Our own ring coming and going: no scan.
    expect(structural(records(row, () => row.append(document.createElement("trench-overlay"))))).toBe(false);
    // The row recycled for another coin, or a new row: a scan.
    expect(
      structural(records(row, () => row.querySelector("a")!.setAttribute("href", `/sol/token/${B}`))),
    ).toBe(true);
    expect(
      structural(records(document.body, () => document.body.append(document.createElement("div")))),
    ).toBe(true);
    expect(axiom.watchedAttributes).toContain("data-pulse-token-address");
    expect(terminal.watchedAttributes).toContain("data-trenches-item");
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

describe("safety screen on the boards", () => {
  const failed = { passed: false, reasons: ["top 10 holders own 52%"], at: new Date().toISOString() };
  const passed = { passed: true, reasons: [], at: new Date().toISOString() };
  function pulse() {
    board(`<section><header><span>New Pairs</span></header>
        <div id="a" data-pulse-token-address="${A}"></div></section>
      <section><header><span>Migrated</span></header>
        <div id="b" data-pulse-token-address="${B}"></div></section>`);
    const asked: string[][] = [];
    const e = new OverlayEngine(axiom, DEFAULT_SETTINGS, {
      lookup: async () => ({ tokens: {}, problem: null }),
      report: () => undefined,
      safety: async (mints) => {
        asked.push(mints);
        return { verdicts: {}, problem: null };
      },
    });
    return { e, asked, a: document.getElementById("a")!, b: document.getElementById("b")! };
  }
  const prefs = (mode: "off" | "hide" | "mark", columns: Partial<Record<string, boolean>> = {}) =>
    cleanTooltip({ safety: { mode, columns } });

  it("asks nothing and changes nothing while it is off", () => {
    const { e, a } = pulse();
    e.start();
    e.scan();
    e.receiveSafety([A], { verdicts: { [A]: failed }, problem: null });
    expect(a.style.display).toBe("");
    expect(a.querySelector("trench-overlay-x")).toBeNull();
    e.stop();
  });

  it("hides a failing coin and shows it again once a scan passes it", () => {
    const { e, a, b } = pulse();
    e.applyTooltip(prefs("hide"));
    e.start();
    e.scan();
    e.receiveSafety([A, B], { verdicts: { [A]: failed, [B]: passed }, problem: null });
    expect(a.style.display).toBe("none");
    expect(b.style.display).toBe("");
    e.receiveSafety([A], { verdicts: { [A]: passed }, problem: null });
    expect(a.style.display).toBe("");
    // A coin TrenchScanner never screened stays.
    e.receiveSafety([A], { verdicts: {}, problem: null });
    expect(a.style.display).toBe("");
    e.stop();
  });

  it("marks a failing coin with an X instead, and only in the columns picked", () => {
    const { e, a, b } = pulse();
    e.applyTooltip(prefs("mark", { graduated: false }));
    e.start();
    e.scan();
    e.receiveSafety([A, B], { verdicts: { [A]: failed, [B]: failed }, problem: null });
    expect(a.querySelector("trench-overlay-x")).not.toBeNull();
    expect(a.style.display).toBe("");
    // Small: a corner tag and an edge, no cover over the row; its hover gives the reasons.
    const mark = a.querySelector("trench-overlay-x") as HTMLElement;
    expect(mark).not.toBeNull();
    expect(safetyBody(A, failed).textContent).toContain("Top 10 holders own 52%.");
    // B sits in Migrated, which the reader left out.
    expect(b.querySelector("trench-overlay-x")).toBeNull();
    e.applyTooltip(prefs("off"));
    expect(a.querySelector("trench-overlay-x")).toBeNull();
    e.stop();
  });

  it("says the safety verdict and why it fails in the ring's tooltip", () => {
    const failing = token({ mint: A, modelCalls: [call], safety: failed });
    const body = tooltipBody(failing, verdictFor(failing, DEFAULT_SETTINGS));
    expect(body.textContent).toContain("Safety screen");
    expect(body.textContent).toContain("Failed");
    expect(body.textContent).toContain("Top 10 holders own 52%.");
    const fine = token({ mint: A, modelCalls: [call], safety: passed });
    expect(tooltipBody(fine, verdictFor(fine, DEFAULT_SETTINGS)).textContent).toContain("Passed");
    const unscreened = token({ mint: A, modelCalls: [call] });
    expect(tooltipBody(unscreened, verdictFor(unscreened, DEFAULT_SETTINGS)).textContent).not.toContain(
      "Safety screen",
    );
  });

  it("closes the gap a hidden coin leaves in a virtual list, and opens it again when it passes", () => {
    const C = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    board(`<section><header><span>New Pairs</span></header><div style="height: 300px">
        <div id="s0" style="position: absolute; top: 0px; height: 100px"><div data-pulse-token-address="${A}"></div></div>
        <div id="s1" style="position: absolute; top: 100px; height: 100px"><div data-pulse-token-address="${B}"></div></div>
        <div id="s2" style="position: absolute; top: 200px; height: 100px"><div data-pulse-token-address="${C}"></div></div>
      </div></section><section><header><span>Migrated</span></header></section>`);
    const e = new OverlayEngine(axiom, DEFAULT_SETTINGS, {
      lookup: async () => ({ tokens: {}, problem: null }),
      report: () => undefined,
      safety: async () => ({ verdicts: {}, problem: null }),
    });
    e.applyTooltip(prefs("hide"));
    e.start();
    e.scan();
    e.receiveSafety([A, B, C], { verdicts: { [A]: failed, [B]: passed }, problem: null });
    const slot = (id: string) => document.getElementById(id)!;
    expect(slot("s0").style.visibility).toBe("hidden");
    expect(slot("s1").style.translate).toBe("0 -100px");
    expect(slot("s2").style.translate).toBe("0 -100px");
    e.receiveSafety([A], { verdicts: { [A]: passed }, problem: null });
    expect(slot("s0").style.visibility).toBe("");
    expect(slot("s1").style.translate).toBe("");
    e.stop();
  });

  it("puts each row in its column: Terminal's marks, else the headings around it", () => {
    board(
      `<div data-trenches-item="SOLANA:${A}-NEW"></div><div data-trenches-item="SOLANA:${B}-MIGRATED"></div>`,
    );
    const rows = terminal.findRows(document);
    expect(rows.map((r) => columnOf(r, findColumns(document, rows)))).toEqual(["new", "graduated"]);
    const { a, b } = pulse();
    const pulseRows = axiom.findRows(document);
    const boxes = findColumns(document, pulseRows);
    expect([columnOf(a, boxes), columnOf(b, boxes)]).toEqual(["new", "graduated"]);
    // A lone "New" (a tab on a Trending list) makes no column.
    board(`<button>New</button><div id="c" data-pulse-token-address="${A}"></div>`);
    const lone = axiom.findRows(document);
    expect(columnOf(lone[0]!, findColumns(document, lone))).toBe("other");
  });
});

describe("the pill on every coin (user ask 2026-10-26)", () => {
  function pulse() {
    board(
      `<div id="a" data-pulse-token-address="${A}"></div><div id="b" data-pulse-token-address="${B}"></div>`,
    );
    const e = new OverlayEngine(axiom, DEFAULT_SETTINGS, {
      lookup: async () => ({ tokens: {}, problem: null }),
      report: () => undefined,
      stats: async () => ({ tokens: {}, problem: null }),
    });
    return { e, a: document.getElementById("a")!, b: document.getElementById("b")! };
  }
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const numbers = (minutes: number) =>
    token({ mint: B, stats: { ...token().stats!, takenAt: ago(minutes) } });

  it("puts a pill on a coin that isn't an alert, only with the option on and fresh numbers", () => {
    const { e, a, b } = pulse();
    e.start();
    e.scan();
    e.receive([A, B], { tokens: { [A]: token({ modelCalls: [call] }) }, problem: null });
    e.receiveStats([B], { tokens: { [B]: numbers(5) }, problem: null });
    // Off by default: the alert keeps its ring, the other coin stays bare.
    expect(a.querySelector("trench-overlay")).not.toBeNull();
    expect(b.querySelector("trench-overlay")).toBeNull();

    e.applyTooltip(cleanTooltip({ boardStats: { enabled: true, maxAgeMinutes: 30 } }));
    expect(b.querySelector("trench-overlay")).not.toBeNull();
    // Numbers older than the reader allows: no pill.
    e.receiveStats([B], { tokens: { [B]: numbers(45) }, problem: null });
    expect(b.querySelector("trench-overlay")).toBeNull();
    // None at all: none either.
    e.receiveStats([B], { tokens: {}, problem: null });
    expect(b.querySelector("trench-overlay")).toBeNull();
    e.stop();
  });

  it("fills a board pill with numbers, never a bare dot, when the reader's pill is the alert's name and odds", () => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      return attach.call(this, { ...init, mode: "open" });
    };
    try {
      const { e, b } = pulse();
      e.start();
      e.scan();
      e.receive([A, B], { tokens: {}, problem: null });
      e.applyTooltip(cleanTooltip({ boardStats: { enabled: true, maxAgeMinutes: 30 } }));
      e.receiveStats([B], { tokens: { [B]: numbers(5) }, problem: null });
      const badge = b.querySelector("trench-overlay")!.shadowRoot!.querySelector(".badge")!;
      expect(badge.className).not.toContain("dot");
      expect(badge.textContent).toMatch(/h$/);
      e.stop();
    } finally {
      Element.prototype.attachShadow = attach;
    }
  });
});

describe("where rings go (user ask 2026-10-28)", () => {
  /** jsdom lays nothing out: give a box its size on screen. */
  function size(el: Element, width: number, height: number) {
    el.getBoundingClientRect = () => ({ width, height }) as DOMRect;
  }
  const rowsOf = (html: string) => {
    board(html);
    return new Scoper();
  };

  it("keeps the page's own lists and leaves tooltips, menus and popovers bare", () => {
    const s = rowsOf(`<div data-index="0" id="board"><a href="/t/${A}">A</a></div>
      <div role="tooltip"><div id="tip"><a href="/t/${B}">B</a></div></div>
      <div data-radix-popper-content-wrapper=""><div role="dialog"><input type="text"><div id="hover"></div></div></div>
      <ul role="listbox"><li id="option"></li></ul>`);
    expect(s.of(document.getElementById("board"))).toBe("page");
    expect(s.of(document.getElementById("tip"))).toBe("off");
    expect(s.of(document.getElementById("hover"))).toBe("off");
    expect(s.of(document.getElementById("option"))).toBe("off");
  });

  it("rings a full search menu, not a quick search dropdown under the header's box", () => {
    const s = rowsOf(`<header id="header" style="position: fixed; top: 0px;"><input type="search">
        <div style="position: absolute;"><div id="quick"></div></div></header>
      <div id="modal" role="dialog"><input placeholder="Search by name or CA">
        <div role="listbox"><div id="result"></div></div>
        <div role="tooltip"><div id="tipInModal"></div></div></div>`);
    size(document.getElementById("header")!, 1024, 56);
    size(document.getElementById("modal")!, 640, 560);
    expect(s.of(document.getElementById("quick"))).toBe("off");
    expect(s.of(document.getElementById("result"))).toBe("search");
    expect(s.of(document.getElementById("tipInModal"))).toBe("off");
  });

  it("treats a fixed shell holding the board as the page, and a small fixed box as a popover", () => {
    const s = rowsOf(`<div id="shell" style="position: fixed; inset: 0px;"><div id="row"></div></div>
      <div id="pop" style="position: fixed; top: 80px;"><div id="popRow"></div></div>`);
    size(document.getElementById("shell")!, window.innerWidth, window.innerHeight);
    size(document.getElementById("pop")!, 320, 240);
    expect(s.of(document.getElementById("row"))).toBe("page");
    expect(s.of(document.getElementById("popRow"))).toBe("off");
  });

  it("the engine finds no row in a popover, and only column rows on a coin's own page", () => {
    const health: number[] = [];
    const e = new OverlayEngine(axiom, DEFAULT_SETTINGS, {
      lookup: async () => ({ tokens: {}, problem: null }),
      report: (h) => health.push(h.rows),
    });
    board(`<div role="row"><div data-pulse-token-address="${A}"></div></div>
      <div data-index="0"><a href="/t/${B}">B</a></div>
      <div role="tooltip"><div data-index="1"><a href="/t/${B}">B</a></div></div>`);
    e.scan();
    history.pushState(null, "", `/meme/${B}`);
    try {
      e.scan();
    } finally {
      history.pushState(null, "", "/");
    }
    expect(health).toEqual([2, 1]);
    e.stop();
  });
});
