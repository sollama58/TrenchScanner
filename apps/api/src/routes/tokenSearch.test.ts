// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import {
  clearExternalSearchCache,
  ExternalSearchUnavailable,
  matchRank,
  searchUntrackedTokens,
} from "../tokenSearch.js";

/** GET /tokens/search and /tokens/:mint/card - the Live feed's search window. */

const WALLET = "TokenSearchAdmin111111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const MINTS = {
  exact: "TokenSearchExact111111111111111111111111111",
  prefix: "TokenSearchPrefix11111111111111111111111111",
  lookedUp: "TokenSearchLooked11111111111111111111111111",
  nobody: "TokenSearchNobody11111111111111111111111111",
};

describe("matchRank", () => {
  it("puts an exact ticker before a prefix before a name hit", () => {
    expect(matchRank("frog", "FROG", null, "x")).toBeLessThan(matchRank("frog", "FROGGY", null, "x"));
    expect(matchRank("frog", "FROGGY", null, "x")).toBeLessThan(matchRank("frog", "PEPE", "Big frog", "x"));
    expect(matchRank("frog", "PEPE", "Big frog", "x")).toBeLessThan(
      matchRank("frog", "PEPE", "bigfrog", "x"),
    );
  });
});

describe.skipIf(!dbAvailable)("GET /tokens/search", () => {
  // A stand-in DexScreener (started in beforeAll): it lists nothing, or refuses while `dexDown`.
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: WALLET, DEXSCREENER_BASE_URL: "http://127.0.0.1:9" }
    : (undefined as never);
  let dexDown = false;
  let dex: Server | null = null;
  let app: FastifyInstance;
  let cookie = "";
  let userId = "";
  const tokenIds: Record<string, string> = {};

  beforeAll(async () => {
    dex = createServer((_req, res) => {
      res.writeHead(dexDown ? 404 : 200, { "content-type": "application/json" });
      res.end(dexDown ? "{}" : JSON.stringify({ pairs: [] }));
    });
    await new Promise<void>((resolve) => dex!.listen(0, "127.0.0.1", resolve));
    env.DEXSCREENER_BASE_URL = `http://127.0.0.1:${(dex.address() as AddressInfo).port}`;
    userId = (await prisma.user.create({ data: { walletAddress: WALLET } })).id;
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: WALLET,
    });
    const filter = await prisma.userFilter.create({ data: { userId } });
    // The prefix match is the newer token, so ranking (not recency) puts the exact ticker first.
    const rows = [
      ["exact", MINTS.exact, "ZQFROG", "Exact", null, 7_200_000],
      ["prefix", MINTS.prefix, "ZQFROGGY", "Prefix", "pumpfun", 60_000],
      ["lookedUp", MINTS.lookedUp, "ZQFROGX", "Looked", "utility", 30_000],
    ] as const;
    for (const [key, mint, symbol, name, discoverySource, ago] of rows) {
      const token = await prisma.token.create({
        data: { mintAddress: mint, symbol, name, discoverySource, firstSeenAt: new Date(Date.now() - ago) },
      });
      tokenIds[key] = token.id;
    }
    const snapshot = await prisma.tokenSnapshot.create({
      data: {
        tokenId: tokenIds.exact!,
        priceUsd: 1e-5,
        marketCapUsd: 42_000,
        holderCount: 321,
        graduated: true,
      },
    });
    await prisma.match.create({
      data: { userId, filterId: filter.id, tokenId: tokenIds.exact!, snapshotId: snapshot.id, score: 1 },
    });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await new Promise((resolve) => dex?.close(resolve));
    await prisma.token.deleteMany({ where: { id: { in: Object.values(tokenIds) } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  const get = (url: string) => app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookie } });
  type Answer = {
    hits: {
      mint: string;
      marketCapUsd: number | null;
      holderCount: number | null;
      yourAlertAt: string | null;
    }[];
  };

  it("finds tracked tokens best match first, leaving out coins only a lookup added", async () => {
    const res = await get("/tokens/search?q=%24zqfrog");
    expect(res.statusCode).toBe(200);
    const body = res.json() as Answer;
    expect(body.hits.map((h) => h.mint)).toEqual([MINTS.exact, MINTS.prefix]);
    expect(body.hits[0]).toMatchObject({ marketCapUsd: 42_000, holderCount: 321, graduated: true });
    expect(body.hits[0]!.yourAlertAt).not.toBeNull();
    expect(body.hits[1]!.yourAlertAt).toBeNull();
  });

  it("finds one token by its address, and nothing for an untracked one", async () => {
    expect(
      ((await get(`/tokens/search?mint=${MINTS.prefix}`)).json() as Answer).hits.map((h) => h.mint),
    ).toEqual([MINTS.prefix]);
    expect(((await get(`/tokens/search?mint=${MINTS.lookedUp}`)).json() as Answer).hits).toEqual([]);
    expect(((await get(`/tokens/search?mint=${MINTS.nobody}`)).json() as Answer).hits).toEqual([]);
  });

  it("turns away a search too short or with nothing to search", async () => {
    expect((await get("/tokens/search?q=z")).statusCode).toBe(400);
    expect((await get("/tokens/search")).statusCode).toBe(400);
    expect((await get("/tokens/search?mint=abc")).statusCode).toBe(400);
  });

  it("answers a result's card for the token modal", async () => {
    const res = await get(`/tokens/${MINTS.exact}/card`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: "stream",
      tokenId: tokenIds.exact,
      currentMarketCapUsd: 42_000,
    });
    expect((await get(`/tokens/${MINTS.nobody}/card`)).statusCode).toBe(404);
  });

  it("finds untracked coins outside, leaving out tracked ones and quote-coin matches", async () => {
    clearExternalSearchCache();
    const asked: string[] = [];
    const reading = (mintAddress: string, symbol: string, liquidityUsd: number) => ({
      mintAddress,
      symbol,
      name: symbol,
      priceUsd: 1e-5,
      marketCapUsd: 50_000,
      liquidityUsd,
      dexId: "pumpswap",
    });
    const search = async (q: string) => {
      asked.push(q);
      return [
        reading(MINTS.exact, "ZQFROG", 1),
        reading(MINTS.lookedUp, "ZQFROGX", 5),
        reading(MINTS.nobody, "ZQFROGZ", 9),
        reading("TokenSearchQuote111111111111111111111111111", "OTHER", 99),
      ];
    };
    const hits = await searchUntrackedTokens(search, { text: "ZQFrog" });
    // The tracked coin is in the Tracked section; a lookup-only coin isn't tracked, so it's here.
    expect(hits.map((h) => h.mint)).toEqual([MINTS.nobody, MINTS.lookedUp]);
    expect(hits[0]).toMatchObject({ graduated: true, marketCapUsd: 50_000, modelCalls: 0 });
    // A second reader asking the same thing within the minute is answered from the cache.
    await searchUntrackedTokens(search, { text: "zqfrog" });
    expect(asked).toEqual(["zqfrog"]);
    expect((await searchUntrackedTokens(search, { mint: MINTS.nobody })).map((h) => h.mint)).toEqual([
      MINTS.nobody,
    ]);
  });

  it("answers the outside search with the lookup's price and the reader's balance", async () => {
    const res = await get("/utilities/search?q=zqnothing");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hits: [], cost: expect.any(Number), balance: expect.any(Number) });
    expect((await get("/utilities/search")).statusCode).toBe(400);
  });

  it("tells a DexScreener failure apart from no coins, and doesn't keep it", async () => {
    clearExternalSearchCache();
    dexDown = true;
    try {
      const down = await get("/utilities/search?q=zqdown");
      expect(down.statusCode).toBe(502);
      expect((down.json() as { error: string }).error).toMatch(/DexScreener/);
    } finally {
      dexDown = false;
    }
    // Back up: the next search asks again rather than answering the failure from the cache.
    const up = await get("/utilities/search?q=zqdown");
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ hits: [] });
  });

  it("throws on a failed outside search, and asks again next time", async () => {
    clearExternalSearchCache();
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("503");
    };
    await expect(searchUntrackedTokens(failing, { text: "zqfail" })).rejects.toBeInstanceOf(
      ExternalSearchUnavailable,
    );
    await expect(searchUntrackedTokens(failing, { text: "zqfail" })).rejects.toBeInstanceOf(
      ExternalSearchUnavailable,
    );
    expect(calls).toBe(2);
  });
});
