// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import type { WalletProfile } from "../walletProfile.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `wallet-test-${Date.now()}`;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const address = (seed: string) =>
  Array.from({ length: 44 }, (_, i) => B58[(seed.charCodeAt(i % seed.length) * (i + 7)) % B58.length]).join(
    "",
  );
const WALLET = address(`${TAG}-wallet`);
const FUNDER = address(`${TAG}-funder`);
const SIBLING = address(`${TAG}-sibling`);
const CHILD = address(`${TAG}-child`);
const SAME_MINUTE = address(`${TAG}-same-minute`);
const FUNDED_AT = new Date(Date.now() - 86_400_000 * 3);
const MINT = address(`${TAG}-mint`);
const LAUNCH = address(`${TAG}-launch`);
const WALLETS = [WALLET, SIBLING, CHILD, SAME_MINUTE];

describe.skipIf(!dbAvailable)("GET /wallets/:wallet", () => {
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    const env = loadEnv();
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-user` } });
    userId = user.id;
    await prisma.whitelist.create({ data: { walletAddress: `${TAG}-user`, addedBy: TAG } });
    const called = await prisma.token.create({ data: { mintAddress: MINT, symbol: "WLT" } });
    const launched = await prisma.token.create({ data: { mintAddress: LAUNCH, symbol: "DEVC" } });
    for (const t of [called, launched]) {
      await prisma.tokenTradeTape.create({
        data: {
          tokenId: t.id,
          anchorAt: new Date(90_000),
          reason: "called",
          status: "done",
          windowEnd: new Date(1_890_000),
        },
      });
    }
    await prisma.tokenWalletActivity.createMany({
      data: [
        {
          tokenId: called.id,
          wallet: WALLET,
          buys: 1,
          sells: 1,
          solIn: 2,
          solOut: 3.5,
          launchSniper: true,
          trades: [
            [70_000, 1, 2, 100],
            [130_000, -1, 3.5, 100],
          ],
        },
        { tokenId: launched.id, wallet: WALLET, isCreator: true, solIn: 1, solOut: 0.5 },
      ],
    });
    await prisma.walletRisk.createMany({
      data: [
        {
          wallet: WALLET,
          score: 81,
          appearances: 6,
          dumps: 5,
          dumper: true,
          fastExits: 2,
          snipes: 1,
          solIn: 3,
          solOut: 4,
          lastSeenAt: new Date(),
          computedAt: new Date(),
        },
        {
          wallet: SIBLING,
          score: 40,
          appearances: 2,
          dumps: 0,
          fastExits: 0,
          snipes: 0,
          solIn: 1,
          solOut: 1,
          lastSeenAt: new Date(),
          computedAt: new Date(),
        },
      ],
    });
    await prisma.walletFunder.createMany({
      data: [
        {
          wallet: WALLET,
          status: "found",
          funder: FUNDER,
          amountSol: 1.5,
          fundedAt: FUNDED_AT,
        },
        {
          wallet: SAME_MINUTE,
          status: "found",
          funder: address(`${TAG}-other-funder`),
          amountSol: 0.5,
          fundedAt: new Date(FUNDED_AT.getTime() + 20_000),
        },
        { wallet: SIBLING, status: "found", funder: FUNDER, amountSol: 0.8, fundedAt: new Date() },
        { wallet: CHILD, status: "found", funder: WALLET, amountSol: 0.2, fundedAt: new Date() },
      ],
    });
    app = await buildServer(env);
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: user.walletAddress,
    });
  });

  afterAll(async () => {
    await prisma.walletRisk.deleteMany({ where: { wallet: { in: WALLETS } } });
    await prisma.walletFunder.deleteMany({ where: { wallet: { in: WALLETS } } });
    await prisma.whitelist.deleteMany({ where: { walletAddress: `${TAG}-user` } });
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { in: [MINT, LAUNCH] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  const get = (wallet: string, withCookie = true) =>
    app.inject({
      method: "GET",
      url: `/wallets/${wallet}`,
      ...(withCookie ? { cookies: { [SESSION_COOKIE_NAME]: cookie } } : {}),
    });

  it("sends the wallet's score, funder, cluster, coins, trades and launches", async () => {
    const res = await get(WALLET);
    expect(res.statusCode).toBe(200);
    const p = res.json<WalletProfile>();
    expect(p.live).toBeNull();
    expect(p.risk).toMatchObject({ score: 81, coins: 6, dumps: 5, dumper: true, winner: false });
    expect(p.funder).toMatchObject({ status: "found", wallet: FUNDER, amountSol: 1.5, label: null });
    expect(p.labels.map((l) => l.text)).toEqual(["Dev", "Risky", "Known dumper"]);
    expect(p.linked).toEqual([
      expect.objectContaining({ wallet: SIBLING, relation: "sibling", score: 40 }),
      expect.objectContaining({ wallet: CHILD, relation: "funded", score: null }),
      expect.objectContaining({ wallet: SAME_MINUTE, relation: "same-minute", amountSol: 0.5 }),
    ]);
    expect(p.totals).toMatchObject({ coins: 2, solIn: 3, solOut: 4, netSol: 1, profitable: 1 });
    expect(p.coins.find((c) => c.mint === MINT)).toMatchObject({ netSol: 1.5, roles: ["sniper"] });
    expect(p.launches.map((c) => c.mint)).toEqual([LAUNCH]);
    expect(p.trades.map((t) => [t.side, t.sol])).toEqual([
      ["sell", 3.5],
      ["buy", 2],
    ]);
    expect(p.firstSeenAt).not.toBeNull();
  });

  it("answers a wallet it never saw with an empty profile", async () => {
    const res = await get(address(`${TAG}-unknown`));
    expect(res.statusCode).toBe(200);
    expect(res.json<WalletProfile>()).toMatchObject({
      risk: null,
      funder: null,
      coins: [],
      linked: [],
      labels: [],
    });
  });

  it("refuses a malformed address and a reader without access", async () => {
    expect((await get("not-a-wallet")).statusCode).toBe(400);
    expect((await get(WALLET, false)).statusCode).toBe(401);
  });
});
