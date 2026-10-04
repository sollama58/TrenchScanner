// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

/** GET /live/market - the dashboard's 10-second market-cap tick. */

const ADMIN_WALLET = "LiveTickAdmin111111111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `live-tick-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("GET /live/market", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET }
    : (undefined as never);
  let app: FastifyInstance;
  let cookie = "";
  let userId = "";
  let fresh = "";
  let never = "";

  const tick = (query: string, withCookie = true) =>
    app.inject({
      method: "GET",
      url: `/live/market${query}`,
      cookies: withCookie ? { [SESSION_COOKIE_NAME]: cookie } : {},
    });

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: ADMIN_WALLET,
    });
    // Read a second ago, so the tick serves it as is without a lookup.
    fresh = (
      await prisma.token.create({
        data: {
          mintAddress: `${TAG}-fresh`,
          liveMarketCapUsd: 123_456,
          livePriceUsd: 0.000123,
          liveDataAt: new Date(Date.now() - 1_000),
        },
      })
    ).id;
    never = (await prisma.token.create({ data: { mintAddress: `${TAG}-never` } })).id;
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("returns the current reading for each token that has one", async () => {
    const res = await tick(`?tokens=${fresh},${never},${fresh}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { tokens: { id: string; marketCapUsd: number; priceUsd: number }[] };
    // The token with no reading (DexScreener has never heard of this mint) is left out.
    expect(body.tokens).toEqual([
      expect.objectContaining({ id: fresh, marketCapUsd: 123_456, priceUsd: 0.000123 }),
    ]);
  });

  it("rejects a missing or oversized token list", async () => {
    expect((await tick("")).statusCode).toBe(400);
    const tooMany = Array.from({ length: 31 }, (_, i) => `t${i}`).join(",");
    expect((await tick(`?tokens=${tooMany}`)).statusCode).toBe(400);
  });

  it("is behind sign-in like the feeds", async () => {
    expect((await tick(`?tokens=${fresh}`, false)).statusCode).toBe(401);
  });
});
