import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { HeliusClient, parseTokenAccountSlice } from "./helius.js";

const client = () => new HeliusClient({ rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test" });

const MINT_A = bs58.encode(Buffer.alloc(32, 1));
const MINT_B = bs58.encode(Buffer.alloc(32, 2));

/** A token account's first 72 bytes: mint, owner, amount (u64 LE). */
function slice(mint: string, amount: bigint) {
  const bytes = Buffer.alloc(72);
  Buffer.from(bs58.decode(mint)).copy(bytes, 0);
  bytes.writeBigUInt64LE(amount, 64);
  return { pubkey: "acct", account: { data: [bytes.toString("base64"), "base64"] } };
}

type Call = { id: string; method: string; params: unknown[] };

/** Answers each batched call with `answer(call)`; undefined drops it from the reply. */
function mockRpc(answer: (call: Call) => unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const calls = JSON.parse(String((init as RequestInit).body)) as Call[];
    const replies = calls
      .map((c) => {
        const result = answer(c);
        return result === undefined ? undefined : { jsonrpc: "2.0", id: c.id, ...(result as object) };
      })
      .filter(Boolean);
    return new Response(JSON.stringify(replies), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("getTokenBalancesBatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads mint and amount from the sliced account data", () => {
    expect(parseTokenAccountSlice(slice(MINT_A, 123_456_789n))).toEqual({
      mint: MINT_A,
      amount: 123_456_789n,
    });
    expect(parseTokenAccountSlice({ account: { data: ["AAAA", "base64"] } })).toBeNull();
  });

  it("merges both token programs, sums repeat mints and drops zero balances", async () => {
    const fetchSpy = mockRpc((c) => {
      const programId = (c.params[1] as { programId: string }).programId;
      return programId.startsWith("Tokenkeg")
        ? { result: { value: [slice(MINT_A, 5n), slice(MINT_A, 7n), slice(MINT_B, 0n)] } }
        : { result: { value: [slice(MINT_B, 3n)] } };
    });
    const out = await client().getTokenBalancesBatch(["wallet"]);
    expect(out.get("wallet")).toEqual({
      status: "found",
      balances: new Map([
        [MINT_A, 12n],
        [MINT_B, 3n],
      ]),
    });
    // Two calls, one per program, with the 72-byte slice.
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)) as Call[];
    expect(body).toHaveLength(2);
    expect(body[0]!.params[2]).toMatchObject({ encoding: "base64", dataSlice: { offset: 0, length: 72 } });
  });

  it("fails a wallet when either program got no answer", async () => {
    mockRpc((c) =>
      (c.params[1] as { programId: string }).programId.startsWith("Tokenkeg")
        ? { result: { value: [slice(MINT_A, 5n)] } }
        : { error: { code: -32000, message: "busy" } },
    );
    expect((await client().getTokenBalancesBatch(["wallet"])).get("wallet")).toEqual({ status: "failed" });
  });

  it("reads decimals from the mint accounts' one byte", async () => {
    mockRpc((c) => {
      const keys = c.params[0] as string[];
      return {
        result: {
          value: keys.map((k) =>
            k === MINT_A ? { data: [Buffer.from([6]).toString("base64"), "base64"] } : null,
          ),
        },
      };
    });
    const out = await client().getMintDecimals([MINT_A, MINT_B]);
    expect(out).toEqual(new Map([[MINT_A, 6]]));
  });
});
