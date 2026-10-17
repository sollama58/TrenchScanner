import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "./api";
import {
  CHAOS_FRESH_MS,
  chaosPerMinute,
  chaosPicks,
  chaosSite,
  chaosSlots,
  isDesktopBrowser,
  openChaosTabs,
} from "./chaosMode";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("isDesktopBrowser", () => {
  it("takes a desktop browser with a mouse", () => {
    expect(
      isDesktopBrowser({ userAgent: CHROME_MAC, platform: "MacIntel", maxTouchPoints: 0, finePointer: true }),
    ).toBe(true);
  });
  it("refuses phones, and an iPad asking for the desktop site", () => {
    expect(isDesktopBrowser({ userAgent: CHROME_ANDROID, finePointer: false })).toBe(false);
    expect(isDesktopBrowser({ userAgent: IPHONE, finePointer: false })).toBe(false);
    expect(
      isDesktopBrowser({ userAgent: SAFARI_MAC, platform: "MacIntel", maxTouchPoints: 5, finePointer: true }),
    ).toBe(false);
    expect(isDesktopBrowser({ userAgent: CHROME_MAC, mobile: true, finePointer: true })).toBe(false);
  });
  it("refuses a touch-only screen with a desktop user agent", () => {
    expect(isDesktopBrowser({ userAgent: CHROME_MAC, finePointer: false })).toBe(false);
  });
});

describe("chaosSite and chaosPerMinute", () => {
  it("follows the first quick link until a site is picked", () => {
    expect(chaosSite({ chaosSite: null }, ["gmgn", "axiom"])).toBe("gmgn");
    expect(chaosSite({ chaosSite: undefined }, [])).toBe("terminal");
    expect(chaosSite({ chaosSite: "pumpfun" }, ["gmgn"])).toBe("pumpfun");
  });
  it("defaults to 10 and keeps inside 1-60", () => {
    expect(chaosPerMinute({})).toBe(10);
    expect(chaosPerMinute({ chaosPerMinute: 0 })).toBe(1);
    expect(chaosPerMinute({ chaosPerMinute: 500 })).toBe(60);
  });
});

describe("chaosSlots", () => {
  it("counts only the last minute's tabs against the cap", () => {
    const now = 1_000_000;
    const opened = [now - 61_000, now - 30_000, now - 1_000];
    expect(chaosSlots(opened, now, 3, 5)).toEqual({ allowed: 1, recent: [now - 30_000, now - 1_000] });
    expect(chaosSlots(opened, now, 2, 5).allowed).toBe(0);
    expect(chaosSlots([], now, 10, 4).allowed).toBe(4);
  });
});

describe("chaosPicks", () => {
  it("keeps the newest fresh ones, opening oldest first", () => {
    const now = 10_000_000;
    const news = [
      { id: "a", raisedAt: now - 3_000 },
      { id: "stale", raisedAt: now - CHAOS_FRESH_MS - 1 },
      { id: "b", raisedAt: now - 1_000 },
      { id: "c", raisedAt: now - 2_000 },
    ];
    expect(chaosPicks(news, now, 2).map((c) => c.id)).toEqual(["c", "b"]);
    expect(chaosPicks(news, now, 10).map((c) => c.id)).toEqual(["a", "c", "b"]);
  });
});

describe("openChaosTabs", () => {
  const store = new Map<string, string>();
  let opened: string[];
  let block: boolean;
  beforeEach(() => {
    store.clear();
    opened = [];
    block = false;
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal("window", {
      open: (url: string) => {
        if (block) return null;
        opened.push(url);
        return {};
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const now = 50_000_000;
  const mint = (id: number) => `Mint${id}${"x".repeat(36)}`;
  const card = (id: number, ago: number) =>
    ({
      kind: "curated",
      id: String(id),
      token: { mintAddress: mint(id) },
      matchedAt: new Date(now - ago).toISOString(),
    }) as unknown as Card;
  const raised = (c: Card) => Date.parse(c.matchedAt);

  it("opens each alert once, on the picked site, under the cap shared by every tab", () => {
    const prefs = { chaosSite: "pumpfun" as const, chaosPerMinute: 2 };
    openChaosTabs([card(1, 3_000), card(2, 2_000), card(3, 1_000)], raised, prefs, ["terminal"], now);
    expect(opened).toEqual([`https://pump.fun/coin/${mint(2)}`, `https://pump.fun/coin/${mint(3)}`]);
    // Another TrenchScanner tab seeing the same alerts opens nothing more.
    openChaosTabs([card(2, 2_000), card(3, 1_000)], raised, prefs, ["terminal"], now);
    // The cap holds for the rest of the minute, then frees up.
    openChaosTabs([card(4, 500)], raised, prefs, ["terminal"], now + 1_000);
    openChaosTabs([card(5, 0)], raised, prefs, ["terminal"], now + 61_000);
    expect(opened).toEqual([
      `https://pump.fun/coin/${mint(2)}`,
      `https://pump.fun/coin/${mint(3)}`,
      `https://pump.fun/coin/${mint(5)}`,
    ]);
  });

  it("doesn't spend the cap on tabs the browser blocked", () => {
    const prefs = { chaosSite: null, chaosPerMinute: 1 };
    block = true;
    openChaosTabs([card(1, 1_000)], raised, prefs, ["gmgn"], now);
    block = false;
    openChaosTabs([card(2, 500)], raised, prefs, ["gmgn"], now);
    expect(opened).toEqual([`https://gmgn.ai/sol/token/${mint(2)}`]);
  });

  it("hands a blocked alert back, so a tab allowed pop-ups can still open it", () => {
    const prefs = { chaosSite: "pumpfun" as const, chaosPerMinute: 5 };
    block = true;
    openChaosTabs([card(1, 1_000)], raised, prefs, [], now);
    block = false;
    openChaosTabs([card(1, 1_000)], raised, prefs, [], now);
    expect(opened).toEqual([`https://pump.fun/coin/${mint(1)}`]);
  });

  it("never opens a tab for something that isn't a mint address", () => {
    const prefs = { chaosSite: "pumpfun" as const, chaosPerMinute: 5 };
    const bad = { ...card(1, 1_000), token: { mintAddress: "../evil?x=1" } } as unknown as Card;
    openChaosTabs([bad, card(2, 500)], raised, prefs, [], now);
    expect(opened).toEqual([`https://pump.fun/coin/${mint(2)}`]);
  });
});
