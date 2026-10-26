// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { WATCH_MAX, addWatch, listWatches, markSeen, removeWatch } from "./watch.js";

const ME = "BH3uye1nWTdUx8DbbvYtEN4MYx31auwkJbyddwYdKrPp";
const PAID = "GX3WV54fTnJHuLff5sT92gwttiokUNGMouUjGrZ3h5BK";
const MINT = "AsyWatchMint" + "1".repeat(31);
const MADE = "AsyWatchMade" + "1".repeat(31);
const TAG = "asyl-watch-test";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("watchlist", () => {
  let userId = "";
  const now = Date.now();
  const ago = (h: number) => new Date(now - h * 3_600_000);
  const cleanup = async () => {
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await prisma.token.deleteMany({ where: { mintAddress: { in: [MINT, MADE] } } });
    await prisma.walletFunder.deleteMany({ where: { wallet: PAID } });
  };
  beforeAll(async () => {
    await cleanup();
    userId = (await prisma.user.create({ data: { walletAddress: `${TAG}-user` } })).id;
    const t = await prisma.token.create({ data: { mintAddress: MINT, symbol: "BUY" } });
    await prisma.token.create({
      data: { mintAddress: MADE, symbol: "MADE", deployer: ME, launchedAt: ago(1) },
    });
    await prisma.tokenWalletActivity.create({
      data: { tokenId: t.id, wallet: ME, buys: 1, solIn: 2, firstBuyAt: ago(30) },
    });
    await prisma.walletFunder.create({
      data: { wallet: PAID, status: "found", funder: ME, amountSol: 1.5, fundedAt: ago(2) },
    });
  });
  afterAll(cleanup);

  it("lists what a watched wallet did, and counts what came after the last look", async () => {
    expect(await addWatch(userId, ME, "Dev guy", now - 5 * 3_600_000)).toEqual({ ok: true });
    const [row] = await listWatches(userId, now);
    expect(row).toMatchObject({ wallet: ME, name: "Dev guy", fresh: 2 });
    expect(row!.events.map((e) => `${e.kind}:${e.target}`)).toEqual([
      `deployed:${MADE}`,
      `funded:${PAID}`,
      `bought:${MINT}`,
    ]);
    await markSeen(userId, null, now);
    expect((await listWatches(userId, now))[0]!.fresh).toBe(0);
    expect(await removeWatch(userId, ME)).toBe(true);
    expect(await listWatches(userId, now)).toEqual([]);
  });

  it("stops at the cap", async () => {
    const fill = Array.from({ length: WATCH_MAX }, (_, i) => ({ userId, wallet: `w${i}` }));
    await prisma.asylWatch.createMany({ data: fill });
    expect(await addWatch(userId, ME, null)).toEqual({ ok: false, reason: "full" });
    await prisma.asylWatch.deleteMany({ where: { userId } });
  });
});
