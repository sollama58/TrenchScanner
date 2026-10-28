import { afterEach, describe, expect, it, vi } from "vitest";
import { HeliusClient } from "./helius.js";

const client = () => new HeliusClient({ rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test" });
const WALLET = "2cER2peZXLpnJAaStnoDHmXAEmgzkEPMU2f1gbpT5ABv";
const SECONDS = 1_700_000_000;

type Call = { id: string; method: string; params: [string, Record<string, unknown>] };

/** Answers each batched call with `answer(call, n)`, n counting the POSTs from 0. */
function mockRpc(answer: (call: Call, n: number) => object) {
  let n = 0;
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const batch = JSON.parse(String((init as RequestInit).body)) as Call[];
    calls.push(...batch);
    const at = n++;
    return new Response(JSON.stringify(batch.map((c) => ({ jsonrpc: "2.0", id: c.id, ...answer(c, at) }))), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

describe("getWalletSignaturesPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks for 1,000 signatures with the wallet's token accounts, and pages on a full page", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, blockTime: SECONDS - i }));
    const calls = mockRpc(() => ({ result: { data: full, paginationToken: "next" } }));
    const res = await client().getWalletSignaturesPage(WALLET, { paginationToken: "prev" });
    expect(res).toMatchObject({ status: "ok", paginationToken: "next" });
    if (res.status !== "ok") return;
    expect(res.sigs).toHaveLength(1000);
    expect(res.sigs[0]).toEqual({ signature: "s0", at: SECONDS * 1000 });
    expect(calls[0]!.method).toBe("getTransactionsForAddress");
    expect(calls[0]!.params[1]).toMatchObject({
      transactionDetails: "signatures",
      sortOrder: "desc",
      limit: 1000,
      paginationToken: "prev",
      filters: { status: "succeeded", tokenAccounts: "balanceChanged" },
    });
  });

  it("ends on a short page, and asks again without the filter when the node refuses it", async () => {
    const calls = mockRpc((_c, n) =>
      n === 0
        ? { error: { code: -32602, message: "invalid params" } }
        : { result: { data: [{ signature: "only", blockTime: null }], paginationToken: "x" } },
    );
    expect(await client().getWalletSignaturesPage(WALLET)).toEqual({
      status: "ok",
      sigs: [{ signature: "only", at: null }],
      paginationToken: null,
    });
    expect(calls[1]!.params[1].filters).toEqual({ status: "succeeded" });
  });

  it("is unsupported off Helius, and failed on an error", async () => {
    expect(
      await new HeliusClient({ rpcUrl: "https://rpc.example.com" }).getWalletSignaturesPage(WALLET),
    ).toEqual({
      status: "unsupported",
    });
    mockRpc(() => ({ error: { code: -32000, message: "boom" } }));
    expect(await client().getWalletSignaturesPage(WALLET)).toEqual({ status: "failed" });
  });
});
