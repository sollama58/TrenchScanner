// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { matchRank } from "../tokenSearch.js";

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
  const env: Env = dbAvailable ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: WALLET } : (undefined as never);
  let app: FastifyInstance;
  let cookie = "";
  let userId = "";
  const tokenIds: Record<string, string> = {};

  beforeAll(async () => {
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
});
