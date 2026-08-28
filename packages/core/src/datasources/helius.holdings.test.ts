import { afterEach, describe, expect, it, vi } from "vitest";
import { HeliusClient, CASH_EQUIVALENT_MINTS } from "./helius.js";

/** One searchAssets item, shaped like the DAS response. */
function item(mint: string, totalPrice: number | undefined) {
  return {
    id: mint,
    token_info: totalPrice === undefined ? {} : { price_info: { total_price: totalPrice } },
  };
}

function mockFetch(itemsByCall: unknown[][]) {
  let call = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const items = itemsByCall[Math.min(call++, itemsByCall.length - 1)];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { items } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

const client = () => new HeliusClient({ rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test" });

describe("getOtherHoldingsUsdBatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sums non-cash holdings and excludes SOL, USDC and USDT", () => {
    // Sanity-check the exclusion set itself: these three are the whole definition of "cash".
    expect(CASH_EQUIVALENT_MINTS.size).toBe(3);
  });

  it("values a wallet at the sum of its priced, non-cash tokens", async () => {
    mockFetch([
      [
        item("So11111111111111111111111111111111111111112", 5_000), // wSOL - excluded
        item("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 900), // USDC - excluded
        item("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 100), // USDT - excluded
        item("MemeCoin1111111111111111111111111111111111", 30),
        item("MemeCoin2222222222222222222222222222222222", 12.5),
      ],
    ]);
    const out = await client().getOtherHoldingsUsdBatch(["wallet-a"]);
    // A whale in SOL and stables with only $42.50 of actual tokens: cash is not conviction.
    expect(out.get("wallet-a")).toEqual({ status: "found", otherHoldingsUsd: 42.5 });
  });

  it("counts unpriced holdings as nothing, making the figure a floor", async () => {
    // The known limitation, pinned deliberately: an illiquid bag the indexer can't price reads
    // as $0, so the number can only understate - which makes a wallet look emptier, never richer.
    mockFetch([[item("Unpriced11111111111111111111111111111111111", undefined)]]);
    const out = await client().getOtherHoldingsUsdBatch(["wallet-b"]);
    expect(out.get("wallet-b")).toEqual({ status: "found", otherHoldingsUsd: 0 });
  });

  it("reports an empty wallet as a real answer, not a failure", async () => {
    mockFetch([[]]);
    const out = await client().getOtherHoldingsUsdBatch(["wallet-c"]);
    // Crucially "found" with 0, not "failed": this is the sniper-shell case the filter hunts,
    // and treating it as a failure would leave the signal permanently unknown for exactly the
    // wallets it most needs to flag.
    expect(out.get("wallet-c")).toEqual({ status: "found", otherHoldingsUsd: 0 });
  });

  it("never calls a non-Helius endpoint, which cannot serve DAS", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const publicClient = new HeliusClient(); // no key -> public fallback
    const out = await publicClient.getOtherHoldingsUsdBatch(["wallet-d"]);
    expect(out.get("wallet-d")).toEqual({ status: "unsupported" });
    expect(publicClient.holdingsLookupAvailable).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("latches off after a method-not-found, and stops spending calls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32601, message: "Method not found" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const c = client();
    expect((await c.getOtherHoldingsUsdBatch(["w1"])).get("w1")).toEqual({ status: "failed" });
    expect(c.holdingsLookupAvailable).toBe(false);

    // Latched: the second round answers from the latch without another request.
    const callsBefore = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect((await c.getOtherHoldingsUsdBatch(["w2"])).get("w2")).toEqual({ status: "unsupported" });
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      callsBefore,
    );
  });

  it("values a holding from a unit price when no total is given", async () => {
    // Regression: the sum used to read total_price only, so a response carrying price_per_token
    // and a balance - the same facts, one field apart - valued the wallet at nothing.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            items: [
              {
                id: "MemeCoin1111111111111111111111111111111111",
                token_info: {
                  balance: 2_000_000_000_000,
                  decimals: 6,
                  price_info: { price_per_token: 0.00005 },
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const out = await client().getOtherHoldingsUsdBatch(["wallet-e"]);
    // 2,000,000,000,000 raw at 6 decimals = 2,000,000 whole tokens x $0.00005 = $100.
    expect(out.get("wallet-e")).toEqual({ status: "found", otherHoldingsUsd: 100 });
  });

  it("discards a batch where nothing at all could be priced, instead of calling every wallet empty", async () => {
    // The silent-failure guard. If the price field moves or the feed goes down, every wallet
    // reads $0, every holder list scores 100% empty, and the filter quietly rejects everything.
    // A round with plenty of holdings and not one price is treated as a broken pipe: nothing is
    // cached, the signal stays unknown, and unknown skips the filter.
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `Unpriced${String(i).padStart(35, "0")}`,
      token_info: { balance: 1_000_000 },
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { items: many } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const out = await client().getOtherHoldingsUsdBatch(["wallet-f"]);
    expect(out.get("wallet-f")).toEqual({ status: "failed" });
  });

  it("still reports a lone unpriced bag honestly rather than tripping the guard", async () => {
    // The other side of that tradeoff: a single shell wallet holding one unpriced memecoin is
    // exactly what the filter hunts, and must not be mistaken for a broken price feed.
    mockFetch([[item("Unpriced11111111111111111111111111111111111", undefined)]]);
    const out = await client().getOtherHoldingsUsdBatch(["wallet-g"]);
    expect(out.get("wallet-g")).toEqual({ status: "found", otherHoldingsUsd: 0 });
  });

  it("asks searchAssets for fungibles under the params shape it documents", async () => {
    // Regression: showZeroBalance was sent as `displayOptions`, which is getAssetsByOwner's
    // spelling - searchAssets nests it under `options`.
    const spy = mockFetch([[]]);
    await client().getOtherHoldingsUsdBatch(["wallet-h"]);
    const body = JSON.parse((spy.mock.calls[0]![1] as { body: string }).body);
    expect(body.method).toBe("searchAssets");
    expect(body.params).toMatchObject({
      ownerAddress: "wallet-h",
      tokenType: "fungible",
      options: { showZeroBalance: false },
    });
    expect(body.params.displayOptions).toBeUndefined();
  });

  it("counts every call for the metered-plan spend log", async () => {
    mockFetch([[]]);
    const c = client();
    await c.getOtherHoldingsUsdBatch(["w1", "w2", "w3"]);
    expect(c.takeCallStats()).toMatchObject({ searchAssets: 3 });
  });

  it("dedupes repeated addresses - the same whale tops many holder lists", async () => {
    mockFetch([[]]);
    const c = client();
    await c.getOtherHoldingsUsdBatch(["dup", "dup", "dup"]);
    expect(c.takeCallStats()).toMatchObject({ searchAssets: 1 });
  });
});
