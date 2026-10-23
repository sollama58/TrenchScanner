import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "./db.js";
import {
  answeredStatus,
  apiUsageMeter,
  classifyApiRequest,
  clearHeliusCreditsOut,
  HELIUS_CREDITS_OUT_PAUSE_MS,
  heliusCreditsOut,
  HELIUS_CREDITS_OUT_ROW,
  flushApiUsage,
  onHeliusCreditsRestored,
  saysCreditsOut,
  syncHeliusCreditsOut,
  meteredFetch,
  nameApiHost,
  normalizePath,
  providerOf,
  rpcMethods,
  CreditTally,
  tallyHeliusCredits,
  withApiFeature,
  withApiStages,
  withOwnApiFeature,
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

  it("charges nothing for sends through Helius Sender, the global host or a regional one", () => {
    for (const url of [
      "https://sender.helius-rpc.com/fast?api-key=k",
      "http://ewr-sender.helius-rpc.com/fast",
    ]) {
      expect(classifyApiRequest(url, "POST", rpcBody("sendTransaction"))).toEqual([
        { provider: "helius", endpoint: "sendTransaction", calls: 1, credits: 0 },
      ]);
    }
    expect(
      classifyApiRequest("https://mainnet.helius-rpc.com/?api-key=k", "POST", rpcBody("sendTransaction"))[0]!
        .credits,
    ).toBe(1);
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
    // The keyless host bills nothing, and is named apart so its 429s can be told from the key's.
    const [keyless] = classifyApiRequest(`https://lite-api.jup.ag/price/v3?ids=${mint}`, "GET", undefined);
    expect(keyless).toMatchObject({ provider: "jupiter", endpoint: "GET /price/v3 (keyless)", credits: 0 });
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

  it("counts a timer's calls under its own name, not the request that started it", async () => {
    apiUsageMeter.take();
    const line = { provider: "helius", endpoint: "getMultipleAccounts", calls: 1, credits: 1 };
    await withApiFeature("api /tokens/:mint", async () => {
      apiUsageMeter.record([line], ok);
      await withOwnApiFeature("live-curves", async () => apiUsageMeter.record([line], ok));
    });
    const byFeature = Object.fromEntries(apiUsageMeter.take().map((r) => [r.feature, r.counter.calls]));
    expect(byFeature).toEqual({ "api /tokens/:mint": 1, "live-curves": 1 });
  });

  it("tallies a stage's answered Helius credits, under the feature it would have had", async () => {
    apiUsageMeter.take();
    const gtfa = { provider: "helius", endpoint: "getTransactionsForAddress", calls: 1, credits: 10 };
    const dex = { provider: "dexscreener", endpoint: "GET /x", calls: 1, credits: 0 };
    const snipers = new CreditTally();
    const all = new CreditTally();
    await withApiStages("scan", async (stage) => {
      await tallyHeliusCredits(all, () =>
        tallyHeliusCredits(snipers, async () => {
          apiUsageMeter.record([gtfa], ok);
          // A failed answer is not billed, and other providers are not Helius credits.
          apiUsageMeter.record([gtfa], { ...ok, ok: false });
          apiUsageMeter.record([dex], ok);
          // Nested under a feature of its own, still the stage's.
          await withApiFeature("inner", async () => apiUsageMeter.record([gtfa], ok));
        }),
      );
      apiUsageMeter.record([gtfa], ok);
      stage("snipers");
    });
    expect(snipers.take()).toBe(20);
    expect(snipers.take()).toBe(0);
    expect(all.take()).toBe(20);
    const byFeature = Object.fromEntries(
      apiUsageMeter
        .take()
        .filter((r) => r.provider === "helius")
        .map((r) => [r.feature, r.counter.calls]),
    );
    expect(byFeature).toEqual({ "scan/snipers": 3, "scan/inner": 1 });
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

  it("counts Helius identity lookups at 100 credits, a 404 (no name) included", async () => {
    const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const one = classifyApiRequest(`https://api.helius.xyz/v1/wallet/${wallet}/identity`, "GET", undefined);
    expect(one).toEqual([
      { provider: "helius", endpoint: "GET /v1/wallet/:id/identity", calls: 1, credits: 100 },
    ]);
    const batch = classifyApiRequest(
      "https://api.helius.xyz/v1/wallet/batch-identity",
      "POST",
      JSON.stringify({ addresses: [wallet, wallet] }),
    );
    expect(batch).toEqual([
      { provider: "helius", endpoint: "POST /v1/wallet/batch-identity", calls: 1, credits: 100 },
    ]);
    expect(answeredStatus(one, 404)).toBe(true);
    expect(answeredStatus(one, 500)).toBe(false);
    expect(answeredStatus(batch, 404)).toBe(false);
    // CoinGecko's paid API bills an unknown pool; the free host bills nothing to count.
    const paidPool = classifyApiRequest(
      "https://pro-api.coingecko.com/api/v3/onchain/networks/solana/pools/x/ohlcv/minute",
      "GET",
      undefined,
    );
    expect(answeredStatus(paidPool, 404)).toBe(true);
    expect(
      answeredStatus(
        classifyApiRequest("https://api.coingecko.com/api/v3/simple/price", "GET", undefined),
        404,
      ),
    ).toBe(false);
    expect(answeredStatus(classifyApiRequest("https://api.rugcheck.xyz/v1/x", "GET", undefined), 404)).toBe(
      false,
    );
    // RugCheck's "not found" for an unindexed mint is an answer the client caches, not a failure.
    const report = classifyApiRequest(
      `https://api.rugcheck.xyz/v1/tokens/${wallet}/report`,
      "GET",
      undefined,
    );
    expect(answeredStatus(report, 400)).toBe(true);
    expect(answeredStatus(report, 404)).toBe(true);
    expect(answeredStatus(report, 429)).toBe(false);
    expect(answeredStatus(report, 500)).toBe(false);

    apiUsageMeter.take();
    const f = meteredFetch((async () => new Response("{}", { status: 404 })) as typeof fetch);
    await f(`https://api.helius.xyz/v1/wallet/${wallet}/identity`);
    const row = apiUsageMeter.take().find((r) => r.provider === "helius")!;
    expect(row.counter).toMatchObject({ calls: 1, credits: 100, errors: 0 });
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

describe("Helius out of credits", () => {
  it("stands billed Helius calls down for a while after 'max usage reached', and no others", async () => {
    clearHeliusCreditsOut();
    let sent = 0;
    let reply = () => new Response('{"error":{"code":-32429,"message":"rate limited"}}', { status: 429 });
    const f = meteredFetch((async () => {
      sent += 1;
      return reply();
    }) as typeof fetch);
    const call = () => f(helius, { method: "POST", body: rpcBody("getBalance") });
    // A plain rate limit is not credits out.
    await call();
    expect(heliusCreditsOut()).toBeNull();

    reply = () => new Response('{"error":{"code":-32429,"message":"max usage reached"}}', { status: 429 });
    const res = await call();
    expect(await res.text()).toContain("max usage reached");
    expect(heliusCreditsOut()).not.toBeNull();
    expect(sent).toBe(2);
    // Standing down: Helius isn't called, the caller sees a 429.
    expect((await call()).status).toBe(429);
    expect(sent).toBe(2);
    // Free sends through Sender and other providers still go.
    reply = () => new Response("{}", { status: 200 });
    await f("https://sender.helius-rpc.com/fast", { method: "POST", body: rpcBody("sendTransaction") });
    await f("https://api.rugcheck.xyz/v1/x");
    expect(sent).toBe(4);
    // After the pause calls go through again.
    const out = heliusCreditsOut()!;
    expect(heliusCreditsOut(out.until.getTime())).toBeNull();
    expect(out.until.getTime() - out.since.getTime()).toBe(HELIUS_CREDITS_OUT_PAUSE_MS);
    clearHeliusCreditsOut();
    expect((await call()).status).toBe(200);
    expect(sent).toBe(5);
  });
});

describe("saysCreditsOut", () => {
  it("reads the plan's refusal in any of Helius's shapes, and not a rate limit", () => {
    expect(saysCreditsOut("max usage reached")).toBe(true);
    // Helius's whole answers: the JSON-RPC envelope a 429 (or a 200) carries for an exhausted plan.
    expect(
      saysCreditsOut('{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"},"id":"1"}'),
    ).toBe(true);
    expect(
      saysCreditsOut('{"jsonrpc":"2.0","id":1,"error":{"code":-32429,"message":"Max usage reached"}}'),
    ).toBe(true);
    expect(
      saysCreditsOut('{"jsonrpc":"2.0","error":{"code":-32429,"message":"plan credits exhausted"}}'),
    ).toBe(true);
    // Batched: one error per call.
    expect(
      saysCreditsOut(
        '[{"id":"0","error":{"code":-32429,"message":"limit"}},{"id":"1","error":{"code":-32429}}]',
      ),
    ).toBe(true);
    expect(saysCreditsOut('{"error":{"code":-32429,"message":"rate limited"}}')).toBe(false);
    expect(saysCreditsOut('{"error":{"code":-32602,"message":"invalid params"}}')).toBe(false);
    expect(saysCreditsOut('[{"id":"0","result":{"value":null}}]')).toBe(false);
  });
});

describe("Helius out of credits, answered with HTTP 200", () => {
  const json = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } });

  it("stands down on a batch of -32429s, and runs the restored hooks once Helius answers again", async () => {
    clearHeliusCreditsOut();
    let restored = 0;
    onHeliusCreditsRestored(() => {
      restored += 1;
    });
    let reply = () => json('[{"jsonrpc":"2.0","id":"0","error":{"code":-32429,"message":"max usage"}}]');
    const f = meteredFetch((async () => reply()) as typeof fetch);
    apiUsageMeter.take();
    await f(helius, { method: "POST", body: rpcBody("getBalance", "getBalance") });
    const out = heliusCreditsOut()!;
    expect(out).not.toBeNull();
    // Not answered, so not billed.
    const row = apiUsageMeter.take().find((r) => r.provider === "helius")!;
    expect(row.counter).toMatchObject({ calls: 2, errors: 2, credits: 0 });

    // An answer while still within the pause can't happen (the call isn't sent); one after it ends
    // the stand-down.
    vi.useFakeTimers({ now: out.until.getTime() });
    try {
      reply = () => json('[{"jsonrpc":"2.0","id":"0","result":1}]');
      await f(helius, { method: "POST", body: rpcBody("getBalance") });
      expect(restored).toBe(1);
      await f(helius, { method: "POST", body: rpcBody("getBalance") });
      expect(restored).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    clearHeliusCreditsOut();
    expect(restored).toBe(1);
  });
});

describe.skipIf(!dbAvailable)("the stand-down shared through the database", () => {
  afterAll(async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job: HELIUS_CREDITS_OUT_ROW } });
    clearHeliusCreditsOut();
  });

  it("takes on another process's stand-down, and its clear", async () => {
    clearHeliusCreditsOut();
    const now = Date.now();
    // Set after this process last cleared its own.
    const meta = { since: now - 1000, until: now + 600_000, setAt: now + 1, clearedAt: 0 };
    await prisma.systemHeartbeat.upsert({
      where: { job: HELIUS_CREDITS_OUT_ROW },
      create: { job: HELIUS_CREDITS_OUT_ROW, lastRunAt: new Date(now), meta },
      update: { meta },
    });
    await syncHeliusCreditsOut(now);
    expect(heliusCreditsOut(now)?.until.getTime()).toBe(meta.until);

    const cleared = { ...meta, until: now + 2, clearedAt: now + 2 };
    await prisma.systemHeartbeat.update({ where: { job: HELIUS_CREDITS_OUT_ROW }, data: { meta: cleared } });
    await syncHeliusCreditsOut(now + 3);
    expect(heliusCreditsOut(now + 3)).toBeNull();
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
