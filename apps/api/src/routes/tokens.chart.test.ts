// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { setCandleFetcherForTests, type TokenChart } from "./tokens.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `chart-test-${Date.now()}`;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const address = (seed: string) =>
  Array.from({ length: 44 }, (_, i) => B58[(seed.charCodeAt(i % seed.length) * (i + 7)) % B58.length]).join(
    "",
  );
const MINT = address(`${TAG}-mint`);
const RISKY = address(`${TAG}-risky`);
const LINKED = address(`${TAG}-linked`);
const CALM = address(`${TAG}-calm`);

describe.skipIf(!dbAvailable)("GET /tokens/:mint/chart", () => {
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    setCandleFetcherForTests(async (mint) =>
      mint === MINT
        ? [
            { t: 60_000, o: 10_000, h: 12_000, l: 9_000, c: 11_000 },
            { t: 120_000, o: 11_000, h: 20_000, l: 11_000, c: 19_000 },
          ]
        : null,
    );
    const env = loadEnv();
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    userId = user.id;
    await prisma.whitelist.create({ data: { walletAddress: `${TAG}-wallet`, addedBy: TAG } });
    const token = await prisma.token.create({ data: { mintAddress: MINT, symbol: "CHRT" } });
    await prisma.tokenSnapshot.createMany({
      data: [
        { tokenId: token.id, takenAt: new Date(Date.now() - 120_000), priceUsd: 1, marketCapUsd: 10_000 },
        {
          tokenId: token.id,
          takenAt: new Date(Date.now() - 60_000),
          priceUsd: 2,
          marketCapUsd: 20_000,
          linkedClusters: [
            { funder: "Fundr", wallets: [{ wallet: LINKED, pct: 4 }], pct: 4, creatorLinked: false },
          ],
        },
      ],
    });
    await prisma.tokenTradeTape.create({
      data: {
        tokenId: token.id,
        anchorAt: new Date(90_000),
        reason: "called",
        status: "done",
        windowEnd: new Date(1_890_000),
      },
    });
    await prisma.tokenWalletActivity.createMany({
      data: [
        {
          tokenId: token.id,
          wallet: RISKY,
          solIn: 2,
          trades: [
            [70_000, 1, 2, 100],
            [130_000, -1, 3, 100],
          ],
        },
        { tokenId: token.id, wallet: LINKED, solIn: 1, firstBuyAt: new Date(80_000) },
        { tokenId: token.id, wallet: CALM, solIn: 5, firstBuyAt: new Date(80_000) },
      ],
    });
    await prisma.walletRisk.createMany({
      data: [RISKY, CALM].map((wallet) => ({
        wallet,
        score: wallet === RISKY ? 88 : 10,
        appearances: 5,
        dumps: wallet === RISKY ? 4 : 0,
        fastExits: 0,
        snipes: 0,
        solIn: 1,
        solOut: 1,
        lastSeenAt: new Date(),
        computedAt: new Date(),
      })),
    });
    app = await buildServer(env);
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: user.walletAddress,
    });
  });

  afterAll(async () => {
    await prisma.walletRisk.deleteMany({ where: { wallet: { in: [RISKY, CALM] } } });
    await prisma.whitelist.deleteMany({ where: { walletAddress: `${TAG}-wallet` } });
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: MINT } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  const get = (mint: string) =>
    app.inject({ method: "GET", url: `/tokens/${mint}/chart`, cookies: { [SESSION_COOKIE_NAME]: cookie } });

  it("sends the candles, the scan's market caps and the flagged wallets' trades", async () => {
    const res = await get(MINT);
    expect(res.statusCode).toBe(200);
    const body = res.json<TokenChart>();
    expect(body.candles).toHaveLength(2);
    expect(body.marketCap.map((p) => p.usd)).toEqual([10_000, 20_000]);
    expect(body.tape).toMatchObject({ status: "done", anchorAt: 90_000 });
    expect(body.wallets.map((w) => w.wallet)).toEqual([RISKY, LINKED]);
    expect(body.wallets[0]).toMatchObject({
      tags: ["risky", "dumper"],
      score: 88,
      trades: [
        [70_000, 1, 2],
        [130_000, -1, 3],
      ],
    });
    expect(body.wallets[1]).toMatchObject({ tags: ["linked"], funder: "Fundr", trades: [[80_000, 1, null]] });
  });

  it("answers an unknown coin with no candles and nothing to mark", async () => {
    const res = await get(address(`${TAG}-unknown`));
    expect(res.statusCode).toBe(200);
    expect(res.json<TokenChart>()).toMatchObject({ candles: null, marketCap: [], tape: null, wallets: [] });
  });

  it("refuses a malformed mint and a reader without a session", async () => {
    expect((await get("not-a-mint")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/tokens/${MINT}/chart` })).statusCode).toBe(401);
  });
});
