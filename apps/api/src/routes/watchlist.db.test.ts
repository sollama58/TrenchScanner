// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import { WATCHLIST_CAP } from "../watchlist.js";

const ADMIN = "WatchAdmin111111111111111111111111111111111";
const MEMBER = "WatchMember11111111111111111111111111111111";
const LAPSED = "WatchLapsed11111111111111111111111111111111";
const MINT = "WatchMintA111111111111111111111111111111pump";
const B58 = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const extraMint = (i: number) =>
  `WatchX${B58[Math.floor(i / B58.length)]}${B58[i % B58.length]}${"1".repeat(32)}`;
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("watchlist routes", () => {
  const env: Env = dbAvailable ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN } : (undefined as never);
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];
  const mints = [MINT, ...Array.from({ length: WATCHLIST_CAP }, (_, i) => extraMint(i))];
  let tokenId = "";

  const as = (who: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, cookies: { [SESSION_COOKIE_NAME]: cookies[who]! } });

  beforeAll(async () => {
    resetContestStateCache();
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    for (const wallet of [ADMIN, MEMBER, LAPSED]) {
      const user = await prisma.user.upsert({
        where: { walletAddress: wallet },
        update: {},
        create: { walletAddress: wallet },
      });
      userIds.push(user.id);
      cookies[wallet] = await signer.sign({ userId: user.id, walletAddress: wallet });
    }
    await prisma.whitelist.upsert({
      where: { walletAddress: MEMBER },
      update: {},
      create: { walletAddress: MEMBER, addedBy: ADMIN },
    });
    await prisma.token.deleteMany({ where: { mintAddress: { in: mints } } });
    const token = await prisma.token.create({
      data: {
        mintAddress: MINT,
        symbol: "WATCH",
        name: "Watch Coin",
        imageUrl: "https://img.example/watch.png",
        liveMarketCapUsd: 80_000,
        livePriceUsd: 0.00008,
        liveDataAt: new Date(Date.now() - 60_000),
      },
    });
    tokenId = token.id;
    await prisma.tokenSnapshot.create({
      data: {
        tokenId,
        takenAt: new Date(Date.now() - 5 * 60_000),
        priceUsd: 0.00007,
        marketCapUsd: 70_000,
        liquidityUsd: 10_000,
        volume24hUsd: 5_000,
        holderCount: 100,
        priceChange1hPct: 42,
      } as never,
    });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { in: mints } } });
    await prisma.whitelist.deleteMany({ where: { walletAddress: MEMBER } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("is behind the subscriber gate", async () => {
    expect((await app.inject({ method: "GET", url: "/watchlist" })).statusCode).toBe(401);
    expect((await as(LAPSED, "GET", "/watchlist")).statusCode).toBe(402);
  });

  it("stars a token by mint with the reading it has now, and lists it", async () => {
    const added = await as(MEMBER, "POST", "/watchlist", { mint: MINT });
    expect(added.statusCode).toBe(201);
    expect(added.json().item).toMatchObject({
      tokenId,
      mint: MINT,
      symbol: "WATCH",
      addedMarketCapUsd: 80_000,
      marketCapUsd: 80_000,
      changeSinceAddedPct: 0,
      priceChange1hPct: 42,
    });
    // Starring it again is a no-op.
    const again = await as(MEMBER, "POST", "/watchlist", { tokenId });
    expect(again.statusCode).toBe(200);

    await prisma.token.update({
      where: { id: tokenId },
      data: { liveMarketCapUsd: 120_000, liveDataAt: new Date() },
    });
    const list = await as(MEMBER, "GET", "/watchlist");
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.cap).toBe(WATCHLIST_CAP);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].marketCapUsd).toBe(120_000);
    expect(body.items[0].changeSinceAddedPct).toBeCloseTo(50);
    // Another account's list is its own.
    expect((await as(ADMIN, "GET", "/watchlist")).json().items).toEqual([]);
  });

  it("validates the body and refuses unknown tokens", async () => {
    expect((await as(MEMBER, "POST", "/watchlist", {})).statusCode).toBe(400);
    expect((await as(MEMBER, "POST", "/watchlist", { mint: "not a mint" })).statusCode).toBe(400);
    expect((await as(MEMBER, "POST", "/watchlist", { tokenId, mint: MINT })).statusCode).toBe(400);
    expect((await as(MEMBER, "POST", "/watchlist", { tokenId: "nope" })).statusCode).toBe(404);
  });

  it("unstars a token", async () => {
    expect((await as(MEMBER, "DELETE", `/watchlist/${tokenId}`)).json()).toEqual({ removed: true });
    expect((await as(MEMBER, "DELETE", `/watchlist/${tokenId}`)).json()).toEqual({ removed: false });
    expect((await as(MEMBER, "GET", "/watchlist")).json().items).toEqual([]);
  });

  it("holds an account to the cap", async () => {
    await prisma.token.createMany({
      data: Array.from({ length: WATCHLIST_CAP }, (_, i) => ({ mintAddress: extraMint(i) })),
    });
    const extras = await prisma.token.findMany({
      where: { mintAddress: { in: mints.slice(1) } },
      select: { id: true },
    });
    await prisma.watchlistItem.createMany({
      data: extras.map((t) => ({ userId: userIds[0]!, tokenId: t.id })),
    });
    const full = await as(ADMIN, "POST", "/watchlist", { tokenId });
    expect(full.statusCode).toBe(409);
    expect(full.json().cap).toBe(WATCHLIST_CAP);
    expect((await as(ADMIN, "GET", "/watchlist")).json().items).toHaveLength(WATCHLIST_CAP);
  });
});
