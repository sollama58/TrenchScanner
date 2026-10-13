import { afterEach, describe, expect, it, vi } from "vitest";
import { parseKolPage, SolanaTrackerClient } from "./solanaTracker.js";

const A = "suqh5sHtr8HyJ7q8scBimULPkPpA557prMG47xCHQfK";
const B = "515vh1DrPuwMATt9Zoq9kP4sJL9fyojA1dHJu4DQpNRp";

afterEach(() => vi.unstubAllGlobals());

describe("parseKolPage", () => {
  it("reads wallet, name, X handle and stats, and drops rows without an address", () => {
    const page = parseKolPage({
      traders: [
        {
          wallet: A,
          pnl: { realized: 34046905.21 },
          winRate: 67.53,
          timing: { lastTrade: 1776621830045 },
          identity: { name: "Cupsey", twitter: "@@Cupseyy" },
        },
        { wallet: B, identity: { name: "crypto cir...", twitter: null } },
        { wallet: "not an address", identity: { name: "x" } },
        { wallet: A.slice(0, 40), identity: { name: "Bad handle", twitter: "<script>" } },
      ],
      pagination: { hasMore: true, nextCursor: "abc" },
    });
    expect(page.nextCursor).toBe("abc");
    expect(page.kols).toEqual([
      {
        wallet: A,
        name: "Cupsey",
        twitter: "Cupseyy",
        realizedPnlUsd: 34046905.21,
        winRate: 67.53,
        lastTradeAt: new Date(1776621830045),
      },
      {
        wallet: B,
        name: "crypto cir...",
        twitter: null,
        realizedPnlUsd: null,
        winRate: null,
        lastTradeAt: null,
      },
      {
        wallet: A.slice(0, 40),
        name: "Bad handle",
        twitter: null,
        realizedPnlUsd: null,
        winRate: null,
        lastTradeAt: null,
      },
    ]);
    expect(
      parseKolPage({ traders: [], pagination: { hasMore: false, nextCursor: "x" } }).nextCursor,
    ).toBeNull();
    expect(parseKolPage(null)).toEqual({ kols: [], nextCursor: null });
  });
});

describe("SolanaTrackerClient", () => {
  it("asks for a page of the KOL leaderboard with the key and cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ traders: [], pagination: { hasMore: false, nextCursor: null } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await new SolanaTrackerClient("key").kolPage("cur");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://data.solanatracker.io/v2/pnl/leaderboard/kols?sort=realized&limit=100&cursor=cur",
    );
    expect(init.headers).toEqual({ "x-api-key": "key" });
  });
});
