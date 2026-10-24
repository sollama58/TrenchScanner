// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import { ViewStampBuffer } from "../viewStamps.js";

const ADMIN = "TradesPanelAdmin111111111111111111111111111";
const OTHER = "TradesPanelOther111111111111111111111111111";
const MINT = "TradesPanelMint1111111111111111111111111pump";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("GET /pro/trades", () => {
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
  const ids: string[] = [];
  let tokenId = "";

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
      ids.push(user.id);
      cookies[wallet] = await signer.sign({ userId: user.id, walletAddress: wallet });
    }
    const token = await prisma.token.upsert({
      where: { mintAddress: MINT },
      update: {},
      create: {
        mintAddress: MINT,
        symbol: "TPT",
        name: "Trades Panel Test",
        firstSeenAt: new Date(),
        livePriceUsd: 0.00002,
      },
    });
    tokenId = token.id;
    const at = Date.now() - 30 * 60_000;
    await prisma.proTrade.createMany({
      data: [
        {
          wallet: ADMIN,
          signature: "tp1",
          mint: MINT,
          side: "buy",
          lamports: -1_000_000_000n,
          tokens: 10_000_000_000_000n,
          decimals: 6,
          at: new Date(at),
          entry: true,
        },
        {
          wallet: ADMIN,
          signature: "tp2",
          mint: MINT,
          side: "sell",
          lamports: 800_000_000n,
          tokens: -5_000_000_000_000n,
          decimals: 6,
          at: new Date(at + 60_000),
        },
      ],
    });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.proTrade.deleteMany({ where: { wallet: { in: [ADMIN, OTHER] } } });
    await prisma.token.deleteMany({ where: { id: tokenId } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("is not there for a wallet without Pro Mode", async () => {
    expect((await as(OTHER, "/pro/trades")).statusCode).toBe(404);
    expect((await as(OTHER, "/pro/trades?brief=1")).statusCode).toBe(404);
  });

  it("lists the Pro wallet's coins with their trade and figures", async () => {
    const brief = await as(ADMIN, "/pro/trades?brief=1");
    expect(brief.statusCode).toBe(200);
    expect(brief.json().coins).toEqual([
      expect.objectContaining({ mint: MINT, symbol: "TPT", closed: false }),
    ]);

    const full = await as(ADMIN, "/pro/trades");
    expect(full.statusCode).toBe(200);
    const body = full.json();
    expect(body.coins).toHaveLength(1);
    expect(body.coins[0]).toMatchObject({
      mint: MINT,
      buys: 1,
      sells: 1,
      spentSol: 1,
      gotSol: 0.8,
      held: 5_000_000,
      closed: false,
      card: expect.objectContaining({ kind: "stream", tokenId }),
      // No live read in tests: the stored price stands in, and says so.
      priceSource: "stored",
      chainHeld: null,
      mismatch: false,
    });
    expect(typeof body.readAt).toBe("string");
    expect(body.stats).toMatchObject({
      trades: 2,
      buys: 1,
      sells: 1,
      coins: 1,
      open: 1,
      closed: 0,
      entries: 1,
    });
  });

  it("stamps an open panel's coins even right after a closed panel's read", async () => {
    const record = vi.spyOn(ViewStampBuffer.prototype, "record");
    try {
      // The previous test's full read is still cached; the open panel's read is not served from it.
      expect((await as(ADMIN, "/pro/trades")).statusCode).toBe(200);
      expect((await as(ADMIN, "/pro/trades?open=1")).statusCode).toBe(200);
      expect(record).toHaveBeenCalledWith([tokenId]);
    } finally {
      record.mockRestore();
    }
  });
});
