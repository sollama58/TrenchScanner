import { afterEach, describe, expect, it, vi } from "vitest";
import { withApiFeature, withOwnApiFeature } from "../apiUsage.js";
import { prisma } from "../db.js";
import {
  CoinGeckoBudget,
  CoinGeckoBudgetSpentError,
  coinGeckoBudget,
  coinGeckoLaneOf,
} from "./coingeckoBudget.js";
import { GeckoTerminalClient } from "./geckoterminal.js";
import { RateGateDeadlineError } from "./rateGate.js";

const DAY = 86_400_000;
const NOON = Date.UTC(2026, 9, 23, 12);
const config = { dailyCredits: 100, peakDailyCredits: 10, chartDailyCredits: 20 };

describe("coinGeckoLaneOf", () => {
  it("files Peaks and the re-grades, the backfill and everything else apart", () => {
    expect(coinGeckoLaneOf("candle-peaks")).toBe("peaks");
    expect(coinGeckoLaneOf("label-regrade")).toBe("peaks");
    expect(coinGeckoLaneOf("candle-backfill")).toBe("charts");
    expect(coinGeckoLaneOf("scan/marketRefresh")).toBe("market");
    expect(coinGeckoLaneOf("fast-match")).toBe("market");
    expect(coinGeckoLaneOf("api")).toBe("market");
  });
});

describe("CoinGeckoBudget", () => {
  it("allows everything while unconfigured (no paid key)", () => {
    const b = new CoinGeckoBudget();
    for (let i = 0; i < 1_000; i++) b.take("peaks", NOON);
    expect(b.allows("peaks", NOON)).toBe(true);
  });

  it("caps each background lane at its own daily credits", () => {
    const b = new CoinGeckoBudget();
    b.configure(config);
    for (let i = 0; i < 10; i++) b.take("peaks", NOON);
    expect(() => b.take("peaks", NOON)).toThrow(CoinGeckoBudgetSpentError);
    // The other lanes are untouched.
    expect(b.allows("charts", NOON)).toBe(true);
    expect(b.allows("market", NOON)).toBe(true);
  });

  it("stops the background lanes at 85% of the day and the market at the whole day", () => {
    const b = new CoinGeckoBudget();
    b.configure({ ...config, peakDailyCredits: 1_000, chartDailyCredits: 1_000 });
    b.setSynced([{ feature: "fast-match", credits: 85 }], NOON);
    expect(b.allows("peaks", NOON)).toBe(false);
    expect(b.allows("charts", NOON)).toBe(false);
    expect(b.allows("market", NOON)).toBe(true);
    for (let i = 0; i < 15; i++) b.take("market", NOON);
    expect(b.allows("market", NOON)).toBe(false);
  });

  it("counts what every process spent today, and starts over the next UTC day", () => {
    const b = new CoinGeckoBudget();
    b.configure(config);
    b.setSynced(
      [
        { feature: "candle-peaks", credits: 6 },
        { feature: "label-regrade", credits: 4 },
        { feature: "candle-backfill", credits: 3 },
      ],
      NOON,
    );
    expect(b.spent(NOON)).toMatchObject({ peaks: 10, charts: 3, market: 0, total: 13 });
    expect(b.allows("peaks", NOON)).toBe(false);
    expect(b.allows("peaks", NOON + DAY)).toBe(true);
    expect(b.spent(NOON + DAY).total).toBe(0);
  });

  it("a read replaces what this process counted since the last one", () => {
    const b = new CoinGeckoBudget();
    b.configure(config);
    b.take("charts", NOON);
    b.take("charts", NOON);
    expect(b.spent(NOON).charts).toBe(2);
    b.setSynced([{ feature: "candle-backfill", credits: 2 }], NOON);
    expect(b.spent(NOON).charts).toBe(2);
  });

  it("is a deadline to its callers", () => {
    expect(new CoinGeckoBudgetSpentError("peaks")).toBeInstanceOf(RateGateDeadlineError);
  });
});

describe("GeckoTerminalClient with a paid key", () => {
  afterEach(() => coinGeckoBudget.reset());

  it("sends no call its feature's lane has no room for", async () => {
    coinGeckoBudget.configure({ dailyCredits: 100, peakDailyCredits: 0, chartDailyCredits: 0 });
    const client = new GeckoTerminalClient({ apiKey: "k", baseUrl: "http://127.0.0.1:9" });
    await expect(
      withApiFeature("candle-peaks", () => client.poolMinuteCandles("POOL", "MINT", Date.now())),
    ).rejects.toBeInstanceOf(CoinGeckoBudgetSpentError);
    const failed = new Set<string>();
    coinGeckoBudget.configure({ dailyCredits: 0, peakDailyCredits: 0, chartDailyCredits: 0 });
    const found = await withApiFeature("scan", () =>
      client.getTokensByAddresses(["MINT"], { failed, priority: true }),
    );
    expect(found).toEqual([]);
    expect([...failed]).toEqual(["MINT"]);
  });
});

describe("the chart backfill past its paid budget", () => {
  afterEach(() => {
    coinGeckoBudget.reset();
    vi.restoreAllMocks();
  });

  // 9q57, 2026-10-23: a chart opened after the charts lane ran out had no candles at all.
  it("reads GeckoTerminal's free API, without the key, rather than wait for the next day", async () => {
    coinGeckoBudget.configure({ dailyCredits: 100, peakDailyCredits: 0, chartDailyCredits: 0 });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const client = new GeckoTerminalClient({ apiKey: "k" });
    await withOwnApiFeature("candle-backfill", () => client.poolMinuteCandles("POOL", "MINT", Date.now()));
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toMatch(
      /^https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/solana\/pools\/POOL\/ohlcv\/minute/,
    );
    expect(JSON.stringify(init?.headers ?? {})).not.toContain("x-cg-pro-api-key");
    expect(coinGeckoBudget.spent().charts).toBe(0);
  });
});

describe("the chart backfill with paid budget left", () => {
  afterEach(() => {
    coinGeckoBudget.reset();
    vi.restoreAllMocks();
  });

  it("reads the free API first and keeps the paid credit", async () => {
    coinGeckoBudget.configure(config);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const client = new GeckoTerminalClient({ apiKey: "k" });
    await withOwnApiFeature("candle-backfill", () => client.poolMinuteCandles("POOL", "MINT", Date.now()));
    expect(String(fetch.mock.calls[0]![0])).toMatch(/^https:\/\/api\.geckoterminal\.com\//);
    expect(coinGeckoBudget.spent().charts).toBe(0);
  });
});

describe("CoinGeckoBudget.sync", () => {
  const PROCESS = "coingecko-budget-test";
  afterEach(async () => {
    await prisma.apiUsage.deleteMany({ where: { process: PROCESS } });
  });

  it("reads today's paid credits of every process from ApiUsage, by lane", async () => {
    const now = Date.now();
    const today = new Date(Math.floor(now / DAY) * DAY);
    const row = (feature: string, credits: number, bucket = today, provider = "coingecko") => ({
      bucket,
      process: PROCESS,
      provider,
      endpoint: "GET /x",
      feature,
      calls: credits,
      credits,
    });
    await prisma.apiUsage.createMany({
      data: [
        row("candle-peaks", 7),
        row("candle-backfill", 5),
        row("scan/marketRefresh", 3),
        // Yesterday's, and another provider's, don't count.
        row("candle-peaks", 100, new Date(today.getTime() - 5 * 60_000)),
        row("candle-peaks", 100, today, "helius"),
      ],
    });
    const b = new CoinGeckoBudget();
    b.configure(config);
    await b.sync(now);
    expect(b.spent(now)).toMatchObject({ peaks: 7, charts: 5, market: 3, total: 15 });
  });
});
