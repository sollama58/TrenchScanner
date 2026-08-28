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
