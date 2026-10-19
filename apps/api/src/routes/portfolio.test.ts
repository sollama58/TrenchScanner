// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";

const ADMIN = "PortfolioAdmin11111111111111111111111111111";
const OTHER = "PortfolioOther11111111111111111111111111111";
const OPEN_MINT = "PortfolioOpenMint111111111111111111111pump";
const SOLD_MINT = "PortfolioSoldMint111111111111111111111pump";
const UNTRACKED_MINT = "PortfolioUntracked11111111111111111111pump";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("GET /portfolio", () => {
  const env: Env = dbAvailable
    ? {
        ...loadEnv(),
        ADMIN_WALLET_ADDRESSES: ADMIN,
        PRO_TRADING_ENABLED: true,
        HELIUS_API_KEY: "",
        SOLANA_RPC_URL: "",
      }
    : (undefined as never);
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const tokenIds: string[] = [];

  const as = (who: string, url: string) =>
    app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookies[who]! } });

  beforeAll(async () => {
    resetContestStateCache();
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    for (const wallet of [ADMIN, OTHER]) {
      const user = await prisma.user.upsert({
        where: { walletAddress: wallet },
        update: {},
        create: { walletAddress: wallet },
      });
      userIds.push(user.id);
      cookies[wallet] = await signer.sign({ userId: user.id, walletAddress: wallet });
    }
    await prisma.whitelist.upsert({
      where: { walletAddress: OTHER },
      update: {},
      create: { walletAddress: OTHER, addedBy: ADMIN },
    });
    for (const [mint, symbol] of [
      [OPEN_MINT, "PFO"],
      [SOLD_MINT, "PFS"],
    ] as const) {
      const token = await prisma.token.upsert({
        where: { mintAddress: mint },
        update: {},
        create: { mintAddress: mint, symbol, firstSeenAt: new Date(), livePriceUsd: 0.00002 },
      });
      tokenIds.push(token.id);
    }
    await prisma.tokenWalletActivity.createMany({
      data: [
        { tokenId: tokenIds[0]!, wallet: ADMIN, buys: 2, sells: 1, solIn: 1.5, solOut: 2 },
        { tokenId: tokenIds[1]!, wallet: OTHER, buys: 1, sells: 0, solIn: 0.4, solOut: 0 },
        // Sold with no buy on the tape (bought before it was recorded): no cost, so out of the totals.
        { tokenId: tokenIds[1]!, wallet: ADMIN, buys: 0, sells: 1, solIn: 0, solOut: 2.9 },
      ],
    });
    const at = Date.now() - 2 * 3_600_000;
    const trade = (
      signature: string,
      mint: string,
      side: "buy" | "sell",
      lamports: bigint,
      tokens: bigint,
      min: number,
    ) => ({
      wallet: ADMIN,
      signature,
      mint,
      side,
      lamports,
      tokens,
      decimals: 6,
      at: new Date(at + min * 60_000),
      entry: side === "buy" && min % 10 === 0,
    });
    await prisma.proTrade.createMany({
      data: [
        trade("pf1", OPEN_MINT, "buy", -1_000_000_000n, 10_000_000_000_000n, 0),
        trade("pf2", SOLD_MINT, "buy", -500_000_000n, 1_000_000_000_000n, 10),
        trade("pf3", SOLD_MINT, "sell", 900_000_000n, -1_000_000_000_000n, 15),
        trade("pf4", UNTRACKED_MINT, "buy", -200_000_000n, 1_000_000_000n, 20),
      ],
    });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.proTrade.deleteMany({ where: { wallet: { in: [ADMIN, OTHER] } } });
    await prisma.tokenWalletActivity.deleteMany({ where: { wallet: { in: [ADMIN, OTHER] } } });
    await prisma.token.deleteMany({ where: { id: { in: tokenIds } } });
    await prisma.whitelist.deleteMany({ where: { walletAddress: OTHER } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("needs a session", async () => {
    expect((await app.inject({ method: "GET", url: "/portfolio" })).statusCode).toBe(401);
  });

  it("answers with the signed-in wallet's own account and trades only", async () => {
    const mine = await as(ADMIN, "/portfolio");
    expect(mine.statusCode).toBe(200);
    expect(mine.headers["cache-control"]).toContain("no-store");
    const body = mine.json();
    expect(body.account).toMatchObject({ walletAddress: ADMIN, admin: true, pro: { source: "admin" } });
    // No node to read the chain from in tests: the holdings are left out, not guessed.
    expect(body.holdings).toBeNull();
    expect(body.tape).toMatchObject({ coins: 1, buys: 2, sells: 1, solIn: 1.5, solOut: 2, noBuyCoins: 1 });
    // The sell-only coin stays listed, just out of the totals.
    expect(body.tape.recent.map((r: { mint: string }) => r.mint).sort()).toEqual(
      [OPEN_MINT, SOLD_MINT].sort(),
    );

    // Pro Mode wallets only: anyone else finds nothing there.
    expect((await as(OTHER, "/portfolio")).statusCode).toBe(404);
  });

  it("splits a Pro wallet's positions into open and closed, tracked coins only", async () => {
    const res = await as(ADMIN, "/pro/trades?view=portfolio");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.open.map((c: { mint: string }) => c.mint)).toEqual([OPEN_MINT]);
    expect(body.closed.map((c: { mint: string }) => c.mint)).toEqual([SOLD_MINT]);
    expect(body.untracked).toBe(1);
    expect(body.stats.map((s: { hours: number }) => s.hours)).toEqual([24, 168, 720]);
    expect(body.stats[0]).toMatchObject({ open: 1, closed: 1, winRatePct: 100 });
    expect(body.stats[0].realizedSol).toBeCloseTo(0.4);
    expect((await as(OTHER, "/pro/trades?view=portfolio")).statusCode).toBe(404);
  });
});
