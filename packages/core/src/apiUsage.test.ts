import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "./db.js";
import {
  apiUsageMeter,
  classifyApiRequest,
  flushApiUsage,
  meteredFetch,
  nameApiHost,
  normalizePath,
  providerOf,
  rpcMethods,
  withApiFeature,
  withApiStages,
} from "./apiUsage.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const ok = { requests: 1, ok: true, rateLimited: false, ms: 10 };
const helius = "https://mainnet.helius-rpc.com/?api-key=secret";
const rpcBody = (...methods: string[]) =>
  JSON.stringify(methods.map((method, i) => ({ jsonrpc: "2.0", id: String(i), method, params: [] })));

describe("classifyApiRequest", () => {
  it("counts each JSON-RPC call in a Helius batch, at its credit price", () => {
    const lines = classifyApiRequest(
      helius,
      "POST",
      rpcBody("getMultipleAccounts", "getTransactionsForAddress", "getTransactionsForAddress"),
    );
    expect(lines).toEqual([
      { provider: "helius", endpoint: "getMultipleAccounts", calls: 1, credits: 1 },
      { provider: "helius", endpoint: "getTransactionsForAddress", calls: 2, credits: 20 },
    ]);
  });

  it("names a single DAS call and charges its 10 credits", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "searchAssets",
      params: { ownerAddress: "x" },
    });
    expect(classifyApiRequest(helius, "POST", body)).toEqual([
      { provider: "helius", endpoint: "searchAssets", calls: 1, credits: 10 },
    ]);
  });

  it("charges nothing for RPC calls on a public endpoint", () => {
    const lines = classifyApiRequest(
      "https://solana-rpc.publicnode.com",
      "POST",
      rpcBody("getSignaturesForAddress"),
    );
    expect(lines).toEqual([
      { provider: "solana-public-rpc", endpoint: "getSignaturesForAddress", calls: 1, credits: 0 },
    ]);
  });

  it("gives a REST call its route with the ids taken out", () => {
    const mint = "So11111111111111111111111111111111111111112";
    expect(
      classifyApiRequest(`https://api.dexscreener.com/tokens/v1/solana/${mint},${mint}`, "GET", undefined),
    ).toEqual([{ provider: "dexscreener", endpoint: "GET /tokens/v1/solana/:id", calls: 1, credits: 0 }]);
    expect(
      classifyApiRequest("https://pro-api.coingecko.com/api/v3/onchain/x", "GET", undefined)[0]!.credits,
    ).toBe(1);
    expect(classifyApiRequest("https://api.helius.xyz/v0/transactions", "POST", "{}")[0]!.credits).toBe(100);
  });

  it("charges Jupiter's credits by route: 10 a token search, 1 a price read, 0 to execute", () => {
    const mint = "So11111111111111111111111111111111111111112";
    const credits = (url: string) => classifyApiRequest(url, "GET", undefined)[0]!.credits;
    expect(credits(`https://api.jup.ag/tokens/v2/search?query=${mint},${mint}`)).toBe(10);
    expect(credits(`https://api.jup.ag/price/v3?ids=${mint}`)).toBe(1);
    expect(credits("https://api.jup.ag/tokens/v2/toptrending/1h")).toBe(5);
    expect(credits("https://api.jup.ag/swap/v2/execute")).toBe(0);
    expect(credits("https://api.jup.ag/swap/v1/quote")).toBe(1);
  });

  it("never keeps a Telegram bot token in the endpoint", () => {
    const [line] = classifyApiRequest(
      "https://api.telegram.org/bot123456:AAH-secret-token/sendMessage",
      "POST",
      "{}",
    );
    expect(line!.endpoint).toBe("POST /:id/sendMessage");
    expect(line!.provider).toBe("telegram");
  });
});

describe("helpers", () => {
  it("names hosts", () => {
    expect(providerOf("frontend-api-v3.pump.fun")).toBe("pumpfun");
    expect(providerOf("lite-api.jup.ag")).toBe("jupiter");
    expect(providerOf("example.org")).toBe("example.org");
    nameApiHost("https://tokensage-api.example.com/", "tokensage");
    expect(providerOf("tokensage-api.example.com")).toBe("tokensage");
  });

  it("finds RPC methods only in JSON-RPC bodies", () => {
    expect(rpcMethods('{"method":"getX"}')).toBeNull();
    expect(rpcMethods(rpcBody("a", "b", "a"))).toEqual(["a", "b", "a"]);
    expect(rpcMethods(undefined)).toBeNull();
  });

  it("keeps route names and drops numbers", () => {
    expect(normalizePath("/coins/123/trades")).toBe("/coins/:id/trades");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("feature attribution", () => {
  it("labels calls with the job, and the scan's calls with the stage they ended in", async () => {
    apiUsageMeter.take();
    const line = { provider: "helius", endpoint: "getBalance", calls: 1, credits: 1 };
    await withApiFeature("trade-tape", async () => apiUsageMeter.record([line], ok));
    await withApiStages("scan", async (stage) => {
      apiUsageMeter.record([line], ok);
      await Promise.resolve();
      apiUsageMeter.record([line], ok);
      stage("wallets");
      apiUsageMeter.record([line], ok);
      stage("linkedWallets");
      apiUsageMeter.record([line], ok);
    });
    const byFeature = Object.fromEntries(apiUsageMeter.take().map((r) => [r.feature, r.counter.calls]));
    expect(byFeature).toEqual({ "trade-tape": 1, "scan/wallets": 2, "scan/linkedWallets": 1, scan: 1 });
  });

  it("counts every attempt through the fetch wrapper, failures as errors", async () => {
    apiUsageMeter.take();
    let n = 0;
    const inner = (async () => {
      n += 1;
      if (n === 2) throw new Error("socket hang up");
      return new Response("{}", { status: n === 3 ? 429 : 200 });
    }) as typeof fetch;
    const f = meteredFetch(inner);
    await f(helius, { method: "POST", body: rpcBody("getBalance", "getBalance") });
    await expect(f("https://api.rugcheck.xyz/v1/tokens/x/report")).rejects.toThrow();
    await f("https://api.rugcheck.xyz/v1/tokens/x/report");
    const rows = apiUsageMeter.take();
    const heliusRow = rows.find((r) => r.provider === "helius")!;
    expect(heliusRow.counter).toMatchObject({ calls: 2, requests: 1, credits: 2, errors: 0 });
    const rug = rows.find((r) => r.provider === "rugcheck")!;
    expect(rug.counter).toMatchObject({ calls: 2, requests: 2, errors: 2, rateLimited: 1 });
  });

  it("charges credits only for answered calls, not errors or 429s", async () => {
    apiUsageMeter.take();
    const statuses = [200, 429, 503];
    const inner = (async () => new Response("{}", { status: statuses.shift()! })) as typeof fetch;
    const f = meteredFetch(inner);
    for (let i = 0; i < 3; i++) await f(helius, { method: "POST", body: rpcBody("getBalance") });
    await expect(
      meteredFetch((async () => {
        throw new Error("socket hang up");
      }) as typeof fetch)(helius, { method: "POST", body: rpcBody("getBalance") }),
    ).rejects.toThrow();
    const row = apiUsageMeter.take().find((r) => r.provider === "helius")!;
    expect(row.counter).toMatchObject({ calls: 4, errors: 3, rateLimited: 1, credits: 1 });
  });
});

describe.skipIf(!dbAvailable)("flushApiUsage", () => {
  const PROCESS = "test-api-usage";
  afterAll(async () => {
    await prisma.apiUsage.deleteMany({ where: { process: PROCESS } });
  });

  it("adds into the same row on every flush", async () => {
    apiUsageMeter.take();
    const line = { provider: "helius", endpoint: "getBalance", calls: 3, credits: 3 };
    const at = Date.now();
    apiUsageMeter.add(at, "unit", line, ok);
    expect(await flushApiUsage(PROCESS)).toBe(1);
    apiUsageMeter.add(at, "unit", line, ok);
    await flushApiUsage(PROCESS);
    const rows = await prisma.apiUsage.findMany({ where: { process: PROCESS } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 6, requests: 2, credits: 6, feature: "unit" });
  });
});
