import { afterEach, describe, expect, it, vi } from "vitest";
import { heliusPriorityFeeEstimate, isHeliusRpcUrl } from "./heliusPriorityFee.js";
import { estimateManualFees } from "./manualTrade.js";

const HELIUS = "https://mainnet.helius-rpc.com/?api-key=k";
const MINT = "So11111111111111111111111111111111111111112";

/** Stubs fetch with Helius answering `fee` (or failing), and records what was asked. */
function stubHelius(answer: number | "error" | "down") {
  const bodies: { method: string; params: unknown[] }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (answer === "down") throw new TypeError("fetch failed");
    const body =
      answer === "error"
        ? { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }
        : { jsonrpc: "2.0", id: 1, result: { priorityFeeEstimate: answer } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { bodies, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isHeliusRpcUrl", () => {
  it("knows Helius hosts only", () => {
    expect(isHeliusRpcUrl(HELIUS)).toBe(true);
    expect(isHeliusRpcUrl("https://my-node.helius-rpc.com")).toBe(true);
    expect(isHeliusRpcUrl("https://api.mainnet-beta.solana.com")).toBe(false);
    expect(isHeliusRpcUrl("https://helius-rpc.com.evil.example")).toBe(false);
    expect(isHeliusRpcUrl("not a url")).toBe(false);
    expect(isHeliusRpcUrl(null)).toBe(false);
  });
});

describe("heliusPriorityFeeEstimate", () => {
  it("asks for the accounts at the level given", async () => {
    const { bodies } = stubHelius(123_456.7);
    expect(await heliusPriorityFeeEstimate(HELIUS, ["a", "b"], "VeryHigh")).toBe(123_456n);
    expect(bodies).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getPriorityFeeEstimate",
        params: [{ accountKeys: ["a", "b"], options: { priorityLevel: "VeryHigh" } }],
      },
    ]);
  });

  it("is null off Helius, on an error, or with no number", async () => {
    const { spy } = stubHelius(1);
    expect(await heliusPriorityFeeEstimate("https://api.mainnet-beta.solana.com", ["a"], "High")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    stubHelius("error");
    expect(await heliusPriorityFeeEstimate(HELIUS, ["a"], "High")).toBeNull();
    vi.restoreAllMocks();
    stubHelius("down");
    expect(await heliusPriorityFeeEstimate(HELIUS, ["a"], "High")).toBeNull();
    vi.restoreAllMocks();
    stubHelius(Number.NaN);
    expect(await heliusPriorityFeeEstimate(HELIUS, ["a"], "High")).toBeNull();
  });
});

describe("Pro trade fees on a Helius RPC", () => {
  const fallback = () => {
    const rpc = {
      url: HELIUS,
      asked: 0,
      getPriorityFeeEstimate: async () => {
        rpc.asked++;
        return 40_000n;
      },
    };
    return rpc;
  };

  it("pays Helius's High on Eco and VeryHigh on Turbo, not doubled again", async () => {
    const { bodies } = stubHelius(80_000);
    const rpc = fallback();
    // 80,000 micro-lamports a unit over 250K units: 20,000 lamports, on both tiers.
    expect((await estimateManualFees(rpc, { mint: MINT, speed: "eco" })).priorityFeeLamports).toBe(20_000n);
    expect((await estimateManualFees(rpc, { mint: MINT, speed: "turbo" })).priorityFeeLamports).toBe(20_000n);
    expect(bodies.map((b) => (b.params[0] as { options: unknown }).options)).toEqual([
      { priorityLevel: "High" },
      { priorityLevel: "VeryHigh" },
    ]);
    expect(rpc.asked).toBe(0);
  });

  it("keeps the floor (doubled on Turbo) and the Eco cap", async () => {
    stubHelius(0);
    const rpc = fallback();
    // The 10,000 micro-lamport floor over 250K units: 2,500 lamports; Turbo's 5,000.
    expect((await estimateManualFees(rpc, { mint: MINT, speed: "eco" })).priorityFeeLamports).toBe(2_500n);
    expect((await estimateManualFees(rpc, { mint: MINT, speed: "turbo" })).priorityFeeLamports).toBe(5_000n);
    vi.restoreAllMocks();
    stubHelius(10_000_000);
    expect((await estimateManualFees(rpc, { mint: MINT, speed: "eco" })).priorityFeeLamports).toBe(50_000n);
    expect((await estimateManualFees(rpc, { mint: MINT, speed: "turbo" })).priorityFeeLamports).toBe(
      1_000_000n,
    );
  });

  it("falls back to recent fees when Helius fails or the RPC isn't Helius", async () => {
    stubHelius("down");
    const rpc = fallback();
    // getRecentPrioritizationFees' 40,000, doubled on Turbo.
    expect((await estimateManualFees(rpc, { mint: MINT, speed: "eco" })).priorityFeeLamports).toBe(10_000n);
    expect((await estimateManualFees(rpc, { mint: MINT, speed: "turbo" })).priorityFeeLamports).toBe(20_000n);
    expect(rpc.asked).toBe(2);
    vi.restoreAllMocks();
    const { spy } = stubHelius(80_000);
    const plain = { ...fallback(), url: "https://api.mainnet-beta.solana.com" };
    expect((await estimateManualFees(plain, { mint: MINT, speed: "eco" })).priorityFeeLamports).toBe(10_000n);
    expect(spy).not.toHaveBeenCalled();
  });

  it("asks a Helius backup when the main RPC isn't Helius", async () => {
    const { bodies } = stubHelius(80_000);
    const rpc = { ...fallback(), url: "https://rpc.example", backupUrl: HELIUS };
    expect((await estimateManualFees(rpc, { mint: MINT, speed: "eco" })).priorityFeeLamports).toBe(20_000n);
    expect(bodies).toHaveLength(1);
  });
});
