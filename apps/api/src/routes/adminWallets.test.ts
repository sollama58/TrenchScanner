// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env, type StopCause } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { summarizeStopCauses } from "./adminWallets.js";

const ADMIN_WALLET = "AdminWa11ets11111111111111111111111111111111";
const OTHER_WALLET = "NotAdminWa11ets111111111111111111111111111";
const RISKY = "RiskyWa11et11111111111111111111111111111111";
const MINT = "WaTapeMint1111111111111111111111111111111111";
const BOT = "SideBotWa11et111111111111111111111111111111";
const BOT_KOL = "SideBotKo1Wa11et1111111111111111111111111111";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };

const cause = (lead: StopCause["lead"], sellers: number): StopCause => ({
  v: 1,
  tape: "done",
  anchorAt: "",
  stoppedAt: "",
  sellers,
  soldSol: 1,
  soldTokens: 1,
  shares: {
    creator: 0,
    launchSnipers: lead === "launchSnipers" ? 1 : 0,
    firstBuyers: 0,
    top10: 0,
    other: lead === "other" ? 1 : 0,
  },
  lead,
  top: [],
});

describe("summarizeStopCauses", () => {
  it("counts the role that led each stop and its mean share", () => {
    const s = summarizeStopCauses(
      [cause("launchSnipers", 3), cause("launchSnipers", 5), cause("other", 9)],
      24,
    );
    expect(s).toMatchObject({ stops: 3, medianSellers: 5 });
    expect(s.led.launchSnipers).toBe(2);
    expect(s.meanShare.launchSnipers).toBeCloseTo(0.667, 3);
  });
});

async function call(url: string, as: "admin" | "other") {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: userIds[as],
      walletAddress: as === "admin" ? ADMIN_WALLET : OTHER_WALLET,
    });
    return await app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookie } });
  } finally {
    await app.close();
  }
}

async function cleanup() {
  await prisma.token.deleteMany({ where: { mintAddress: MINT } });
  await prisma.walletRisk.deleteMany({ where: { wallet: RISKY } });
  await prisma.sideWalletBot.deleteMany({ where: { wallet: BOT } });
  await prisma.kolSideLabelRemoval.deleteMany({ where: { wallet: BOT } });
  await prisma.kolWallet.deleteMany({ where: { wallet: BOT_KOL } });
  await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
}

describe.skipIf(!dbAvailable)("admin wallet routes", () => {
  beforeAll(async () => {
    await cleanup();
    userIds.admin = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    userIds.other = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
    const token = await prisma.token.create({ data: { mintAddress: MINT, symbol: "TAPE" } });
    await prisma.tokenTradeTape.create({
      data: {
        tokenId: token.id,
        anchorAt: new Date(),
        reason: "called",
        status: "done",
        windowEnd: new Date(),
      },
    });
    await prisma.tokenWalletActivity.create({
      data: {
        tokenId: token.id,
        wallet: RISKY,
        buys: 1,
        solIn: 2,
        firstBuyerRank: 1,
        launchSniper: true,
        dumpedIntoStop: true,
      },
    });
    await prisma.walletRisk.create({
      data: {
        wallet: RISKY,
        score: 99.5,
        appearances: 40,
        dumps: 30,
        fastExits: 10,
        snipes: 20,
        solIn: 50,
        solOut: 60,
        lastSeenAt: new Date(),
        computedAt: new Date(),
      },
    });
  });
  afterAll(cleanup);

  it("serves admins only", async () => {
    expect((await call("/admin/wallets", "other")).statusCode).toBe(403);
  });

  it("lists the riskiest wallets, one wallet's coins and one coin's wallets", async () => {
    const list = await call("/admin/wallets?limit=200", "admin");
    expect(list.statusCode).toBe(200);
    expect(list.json().wallets.some((w: { wallet: string }) => w.wallet === RISKY)).toBe(true);

    const wallet = (await call(`/admin/wallets/${RISKY}`, "admin")).json();
    expect(wallet.risk.score).toBe(99.5);
    expect(wallet.coins[0]).toMatchObject({ mint: MINT, roles: ["sniper", "buyer #1", "sold into stop"] });

    const coin = (await call(`/admin/wallets/coin/${MINT}`, "admin")).json();
    expect(coin.wallets[0]).toMatchObject({ wallet: RISKY, score: 99.5 });

    expect((await call("/admin/wallets/not-an-address", "admin")).statusCode).toBe(400);
  });

  it("lists the side wallet bots and the KOL side labels removed from them, KOLs named", async () => {
    const now = new Date();
    await prisma.kolWallet.create({ data: { wallet: BOT_KOL, name: "Bot Test KOL", seenAt: now } });
    await prisma.sideWalletBot.create({
      data: {
        wallet: BOT,
        reason: "likelyBot",
        coins30d: 300,
        coinShare: 0.6,
        kols: [BOT_KOL],
        computedAt: now,
      },
    });
    await prisma.kolSideLabelRemoval.create({
      data: {
        wallet: BOT,
        kolWallet: BOT_KOL,
        reason: "likelyBot",
        held: true,
        pct: 100,
        shared: 12,
        kolCoins: 12,
        hours: 24,
        lastAt: now,
      },
    });
    expect((await call("/admin/wallets/bots", "other")).statusCode).toBe(403);
    const res = await call("/admin/wallets/bots", "admin");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rules.bot.minCoins).toBeGreaterThan(0);
    expect(body.bots.find((b: { wallet: string }) => b.wallet === BOT)).toMatchObject({
      reason: "likelyBot",
      coins30d: 300,
      kols: [{ wallet: BOT_KOL, name: "Bot Test KOL" }],
      removedLabels: 1,
    });
    expect(body.removals.find((r: { wallet: string }) => r.wallet === BOT)).toMatchObject({
      kolWallet: BOT_KOL,
      kolName: "Bot Test KOL",
      held: true,
      pct: 100,
    });
  });
});
