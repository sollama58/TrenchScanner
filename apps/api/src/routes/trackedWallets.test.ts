// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import { resetTrackedCache, TRACKED_WALLET_CAP } from "../trackedWallets.js";

const ADMIN = "TrackedAdmin11111111111111111111111111111111";
const MEMBER = "TrackedMember1111111111111111111111111111111";
const LABELED = "TrackedLabeLed11111111111111111111111111111";
const FUNDED = "TrackedFunded111111111111111111111111111111";
const PROBABLE = "TrackedProbabLe1111111111111111111111111111";
/** Base58 addresses for the cap: 25 more than the one above. */
const B58 = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const extra = (i: number) => `TrackedExtra${B58[i]}${"1".repeat(31)}`;
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("labeled wallets", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN, PRO_TRADING_ENABLED: true, PRO_TRADING_PUBLIC: true }
    : (undefined as never);
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const ids: string[] = [];
  const wallets = [
    LABELED,
    FUNDED,
    PROBABLE,
    ...Array.from({ length: TRACKED_WALLET_CAP }, (_, i) => extra(i)),
  ];

  const as = (who: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, cookies: { [SESSION_COOKIE_NAME]: cookies[who]! } });

  beforeAll(async () => {
    resetContestStateCache();
    resetTrackedCache();
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    for (const wallet of [ADMIN, MEMBER]) {
      const user = await prisma.user.upsert({
        where: { walletAddress: wallet },
        update: {},
        create: { walletAddress: wallet },
      });
      ids.push(user.id);
      cookies[wallet] = await signer.sign({ userId: user.id, walletAddress: wallet });
    }
    await prisma.userTrackedWallet.deleteMany({ where: { userId: { in: ids } } });
    // The member has access but not Pro Mode.
    await prisma.whitelist.upsert({
      where: { walletAddress: MEMBER },
      update: {},
      create: { walletAddress: MEMBER, addedBy: ADMIN },
    });
    await prisma.walletFunder.create({ data: { wallet: FUNDED, status: "found", funder: LABELED } });
    await prisma.trackedWalletSide.create({
      data: {
        wallet: PROBABLE,
        trackedWallet: LABELED,
        pct: 90,
        shared: 12,
        kolCoins: 13,
        hours: 24,
        computedAt: new Date(),
      },
    });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.userTrackedWallet.deleteMany({ where: { userId: { in: ids } } });
    await prisma.walletFunder.deleteMany({ where: { wallet: { in: wallets } } });
    await prisma.trackedWalletSide.deleteMany({ where: { trackedWallet: LABELED } });
    await prisma.whitelist.deleteMany({ where: { walletAddress: MEMBER } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("labels a wallet for a Pro Mode account and refuses anyone without it", async () => {
    const refused = await as(MEMBER, "PUT", `/wallets/tracked/${LABELED}`, { name: "Mine" });
    expect(refused.statusCode).toBe(403);
    expect((await as(MEMBER, "GET", "/wallets/tracked")).json()).toMatchObject({ pro: false, wallets: [] });

    const saved = await as(ADMIN, "PUT", `/wallets/tracked/${LABELED}`, {
      name: "  Big​   Fish \n",
      kol: false,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().wallet).toMatchObject({ wallet: LABELED, name: "Big Fish", category: "tracked" });
    expect((await as(ADMIN, "PUT", `/wallets/tracked/${LABELED}`, { name: "​ " })).statusCode).toBe(400);
    expect((await as(ADMIN, "PUT", `/wallets/tracked/not-an-address`, { name: "x" })).statusCode).toBe(400);
  });

  it("shows the label and its sides to the labeler alone", async () => {
    const names = await as(ADMIN, "POST", "/wallets/names", { wallets: [LABELED, FUNDED] });
    expect(names.json().names[LABELED]).toEqual({ name: "Big Fish", source: "tracked", mine: true });
    const sides = (await as(ADMIN, "POST", "/wallets/possible-sides", { wallets: [FUNDED, PROBABLE] })).json()
      .sides;
    expect(sides[FUNDED]).toEqual([
      expect.objectContaining({ kolWallet: LABELED, kolName: "Big Fish", funded: true, tracked: "tracked" }),
    ]);
    expect(sides[PROBABLE]).toEqual([
      expect.objectContaining({ kolWallet: LABELED, pct: 90, shared: 12, hours: 24, tracked: "tracked" }),
    ]);

    // Another account sees none of it.
    expect(
      (await as(MEMBER, "POST", "/wallets/names", { wallets: [LABELED] })).json().names[LABELED],
    ).toBeUndefined();
    expect(
      (await as(MEMBER, "POST", "/wallets/possible-sides", { wallets: [FUNDED, PROBABLE] })).json().sides,
    ).toEqual({});
  });

  it("never puts a label or its sides in the shared reads: the side label export, the KOL lists, the bubble map", async () => {
    for (const who of [ADMIN, MEMBER]) {
      const exported = await as(who, "GET", "/utilities/side-labels");
      expect(exported.statusCode).toBe(200);
      const text = exported.body;
      for (const w of [LABELED, FUNDED, PROBABLE]) expect(text).not.toContain(w);
      expect(text).not.toContain("Big Fish");
      const lists = await as(who, "GET", "/utilities/side-wallets");
      expect(lists.body).not.toContain(LABELED);
      expect(lists.body).not.toContain("Big Fish");
      // The labeled wallet is no KOL of the Side Wallet Checker, even for the one who labeled it.
      expect((await as(who, "GET", `/utilities/side-wallets/${LABELED}`)).body).not.toContain("Big Fish");
    }
  });

  it("marks a label KOL with the KOLs, and renames in place", async () => {
    await as(ADMIN, "PUT", `/wallets/tracked/${LABELED}`, { name: "Whale", kol: true });
    const names = await as(ADMIN, "POST", "/wallets/names", { wallets: [LABELED] });
    expect(names.json().names[LABELED]).toEqual({ name: "Whale", source: "kol", mine: true });
    const list = (await as(ADMIN, "GET", "/wallets/tracked")).json();
    expect(list).toMatchObject({ pro: true, cap: TRACKED_WALLET_CAP });
    expect(list.wallets).toEqual([
      expect.objectContaining({ wallet: LABELED, name: "Whale", category: "kol" }),
    ]);
  });

  it(`holds an account to ${TRACKED_WALLET_CAP} labels`, async () => {
    for (let i = 0; i < TRACKED_WALLET_CAP - 1; i += 1) {
      const r = await as(ADMIN, "PUT", `/wallets/tracked/${extra(i)}`, { name: `W${i}` });
      expect(r.statusCode).toBe(200);
    }
    const over = await as(ADMIN, "PUT", `/wallets/tracked/${extra(TRACKED_WALLET_CAP - 1)}`, {
      name: "One more",
    });
    expect(over.statusCode).toBe(409);
    // Renaming one already held is no new label.
    expect((await as(ADMIN, "PUT", `/wallets/tracked/${extra(0)}`, { name: "Renamed" })).statusCode).toBe(
      200,
    );
    expect(await prisma.userTrackedWallet.count({ where: { userId: ids[0] } })).toBe(TRACKED_WALLET_CAP);
  });

  it("removes a label, and its names and sides go with it", async () => {
    expect((await as(ADMIN, "DELETE", `/wallets/tracked/${LABELED}`)).json()).toEqual({ removed: true });
    expect(
      (await as(ADMIN, "POST", "/wallets/names", { wallets: [LABELED] })).json().names[LABELED],
    ).toBeUndefined();
    expect((await as(ADMIN, "POST", "/wallets/possible-sides", { wallets: [FUNDED] })).json().sides).toEqual(
      {},
    );
    expect((await as(ADMIN, "DELETE", `/wallets/tracked/${LABELED}`)).json()).toEqual({ removed: false });
  });
});
