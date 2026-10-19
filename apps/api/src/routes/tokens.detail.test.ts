// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { clearTokenDetailCache, WHY_RATE_LIMIT } from "./tokens.js";

/**
 * GET /tokens/:mint: the token row and its 50 newest snapshots, which every open token view polls.
 * Shared by its readers for a few seconds, and without each snapshot's flagged trades, which the
 * dashboard never reads there (API audit 2026-10-19).
 */

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `detail-test-${Date.now()}`;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const mint = (seed: string) =>
  Array.from({ length: 44 }, (_, i) => B58[(seed.charCodeAt(i % seed.length) * (i + 11)) % B58.length]).join(
    "",
  );
const MINT = mint(`${TAG}-coin`);
const MISSING = mint(`${TAG}-missing`);

describe.skipIf(!dbAvailable)("GET /tokens/:mint", () => {
  let app: FastifyInstance;
  let cookie: string;
  let adminCookie: string;
  let userId: string;
  let adminId: string;
  let tokenId: string;

  beforeAll(async () => {
    const env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: `${TAG}-admin` };
    adminId = (await prisma.user.create({ data: { walletAddress: `${TAG}-admin` } })).id;
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    userId = user.id;
    await prisma.whitelist.create({ data: { walletAddress: `${TAG}-wallet`, addedBy: TAG } });
    // Found by the scanner, so open to any subscriber.
    const token = await prisma.token.create({
      data: { mintAddress: MINT, symbol: "DTL", discoverySource: "pumpportal" },
    });
    tokenId = token.id;
    await prisma.tokenSnapshot.createMany({
      data: [1, 2].map((i) => ({
        tokenId: token.id,
        takenAt: new Date(Date.now() - (3 - i) * 60_000),
        priceUsd: i,
        marketCapUsd: 10_000 * i,
        rugScreenPassed: true,
        flaggedTrades: [{ wallet: "W", side: 1, sol: 1, atMs: 1 }],
      })),
    });
    app = await buildServer(env);
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: user.walletAddress,
    });
    adminCookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: adminId,
      walletAddress: `${TAG}-admin`,
    });
    clearTokenDetailCache();
  });

  afterAll(async () => {
    await prisma.whitelist.deleteMany({ where: { walletAddress: `${TAG}-wallet` } });
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { in: [MINT, MISSING] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, adminId] } } });
  });

  const get = (m: string) =>
    app.inject({ method: "GET", url: `/tokens/${m}`, cookies: { [SESSION_COOKIE_NAME]: cookie } });

  it("answers the token and its snapshots, newest first, without their flagged trades", async () => {
    const res = await get(MINT);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { symbol: string; snapshots: Record<string, unknown>[] };
    expect(body.symbol).toBe("DTL");
    expect(body.snapshots.map((s) => s.marketCapUsd)).toEqual([20_000, 10_000]);
    expect(body.snapshots[0]).toMatchObject({ rugScreenPassed: true });
    expect(body.snapshots.every((s) => !("flaggedTrades" in s))).toBe(true);
    expect(res.body).not.toContain("aiTextScores");
  });

  it("shares one read between readers for a few seconds", async () => {
    clearTokenDetailCache();
    expect(((await get(MINT)).json() as { snapshots: unknown[] }).snapshots).toHaveLength(2);
    await prisma.tokenSnapshot.create({
      data: { tokenId, takenAt: new Date(), priceUsd: 3, marketCapUsd: 30_000 },
    });
    expect(((await get(MINT)).json() as { snapshots: unknown[] }).snapshots).toHaveLength(2);
    clearTokenDetailCache();
    expect(((await get(MINT)).json() as { snapshots: unknown[] }).snapshots).toHaveLength(3);
  });

  it("doesn't keep a miss: a coin that lands on Token opens at once", async () => {
    // An admin skips the lookup gate, so the route itself answers the miss.
    const asAdmin = () =>
      app.inject({
        method: "GET",
        url: `/tokens/${MISSING}`,
        cookies: { [SESSION_COOKIE_NAME]: adminCookie },
      });
    expect((await asAdmin()).statusCode).toBe(404);
    await prisma.token.create({ data: { mintAddress: MISSING, discoverySource: "pumpportal" } });
    expect((await asAdmin()).statusCode).toBe(200);
  });

  it("limits how often one reader asks why the models did or didn't call a coin", async () => {
    const codes: number[] = [];
    for (let i = 0; i <= WHY_RATE_LIMIT.max; i++) {
      const at = Date.now() - i * 60_000;
      codes.push(
        (
          await app.inject({
            method: "GET",
            url: `/tokens/${MINT}/why?at=${at}`,
            cookies: { [SESSION_COOKIE_NAME]: cookie },
          })
        ).statusCode,
      );
    }
    expect(codes.slice(0, WHY_RATE_LIMIT.max).every((c) => c === 200)).toBe(true);
    expect(codes[WHY_RATE_LIMIT.max]).toBe(429);
  });
});
