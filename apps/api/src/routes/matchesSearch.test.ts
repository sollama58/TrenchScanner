// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

/** GET /matches?mint= - the Live feed's CA search: one token's alerts from this reader's feed. */

const WALLET = "MatchSearchAdmin111111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const MINTS = {
  wanted: "MatchSearchWanted11111111111111111111111111",
  other: "MatchSearchSecond11111111111111111111111111",
  nobody: "MatchSearchNobody11111111111111111111111111",
};

describe.skipIf(!dbAvailable)("GET /matches?mint= and ?q=", () => {
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
    // The token searched for has two alerts, an hour apart; a newer one on another token sits
    // between them in the feed.
    let n = 0;
    for (const [name, mint] of [
      ["wanted", MINTS.wanted],
      ["other", MINTS.other],
    ] as const) {
      const token = await prisma.token.create({ data: { mintAddress: mint, symbol: name } });
      tokenIds[name] = token.id;
      const snapshot = await prisma.tokenSnapshot.create({
        data: { tokenId: token.id, priceUsd: 1e-5, marketCapUsd: 20_000 },
      });
      const times = name === "wanted" ? [3_600_000, 60_000] : [30_000];
      for (const ago of times)
        await prisma.match.create({
          data: {
            userId,
            filterId: filter.id,
            tokenId: token.id,
            snapshotId: snapshot.id,
            score: ++n,
            matchedAt: new Date(Date.now() - ago),
          },
        });
    }
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.token.deleteMany({ where: { id: { in: Object.values(tokenIds) } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  const get = (url: string) => app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookie } });

  it("answers the searched token's alerts alone, newest first", async () => {
    const res = await get(`/matches?page=1&mint=${MINTS.wanted}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { matches: { tokenId: string; score: number }[]; hasMore: boolean };
    expect(body.matches.map((m) => m.tokenId)).toEqual([tokenIds.wanted, tokenIds.wanted]);
    expect(body.matches.map((m) => m.score)).toEqual([2, 1]);
    expect(body.hasMore).toBe(false);
  });

  it("narrows the model calls mixed in the same way", async () => {
    const body = (await get(`/matches?page=1&includeCurated=on&mint=${MINTS.wanted}`)).json() as {
      matches: { tokenId: string }[];
    };
    expect(body.matches.length).toBeGreaterThan(0);
    expect(body.matches.every((m) => m.tokenId === tokenIds.wanted)).toBe(true);
  });

  it("finds a token by ticker (with or without its $), name or part of its address, any case", async () => {
    for (const q of ["$WANT", "want", "searchwanted"]) {
      const body = (await get(`/matches?page=1&includeCurated=on&q=${encodeURIComponent(q)}`)).json() as {
        matches: { tokenId: string }[];
      };
      expect(body.matches.map((m) => m.tokenId)).toEqual([tokenIds.wanted, tokenIds.wanted]);
    }
    const none = (await get("/matches?page=1&q=zzzz")).json() as { matches: unknown[] };
    expect(none.matches).toEqual([]);
    expect((await get("/matches?page=1&q=w")).statusCode).toBe(400);
  });

  it("leaves the whole feed as it was without a search", async () => {
    const body = (await get("/matches?page=1")).json() as { matches: { tokenId: string }[] };
    expect(body.matches.map((m) => m.tokenId)).toEqual([tokenIds.other, tokenIds.wanted, tokenIds.wanted]);
  });

  it("answers an empty page for an address no token has", async () => {
    const body = (await get(`/matches?page=1&mint=${MINTS.nobody}`)).json() as {
      matches: unknown[];
      hasMore: boolean;
    };
    expect(body).toMatchObject({ matches: [], hasMore: false });
  });

  it("turns away something that isn't an address", async () => {
    expect((await get("/matches?page=1&mint=abc")).statusCode).toBe(400);
  });
});
