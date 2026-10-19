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
const ROSTER_KOL = "TrackedRosterKoL111111111111111111111111111";
const ROSTER_SIDE = "TrackedRosterSide11111111111111111111111111";
/** Base58 addresses for the cap: TRACKED_WALLET_CAP more than the ones above. */
const B58 = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const extra = (i: number) =>
  `TrackedExtra${B58[Math.floor(i / B58.length)]}${B58[i % B58.length]}${"1".repeat(30)}`;
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
    await prisma.kolWallet.createMany({
      data: [
        { wallet: ROSTER_KOL, name: "Roster Kol", seenAt: new Date() },
        { wallet: ROSTER_SIDE, name: null, mainWallet: ROSTER_KOL, seenAt: new Date() },
      ],
      skipDuplicates: true,
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
    await prisma.kolWallet.deleteMany({ where: { wallet: { in: [ROSTER_KOL, ROSTER_SIDE] } } });
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
    // Filled straight in the table: the edit route's rate limit is for people, not this loop.
    await prisma.userTrackedWallet.createMany({
      data: Array.from({ length: TRACKED_WALLET_CAP - 1 }, (_, i) => ({
        userId: ids[0]!,
        wallet: extra(i),
        name: `W${i}`,
        category: "tracked",
      })),
    });
    resetTrackedCache();
    const over = await as(ADMIN, "PUT", `/wallets/tracked/${extra(TRACKED_WALLET_CAP - 1)}`, {
      name: "One more",
    });
    expect(over.statusCode).toBe(409);
    // Renaming one already held is no new label.
    expect((await as(ADMIN, "PUT", `/wallets/tracked/${extra(0)}`, { name: "Renamed" })).statusCode).toBe(
      200,
    );
    // An import past the cap renames what is held and leaves the new ones out.
    const imported = await as(ADMIN, "POST", "/wallets/tracked/import", {
      wallets: [
        { wallet: extra(1), name: "From file", kol: true },
        { wallet: extra(TRACKED_WALLET_CAP - 1), name: "Past the cap" },
      ],
    });
    expect(imported.json()).toMatchObject({ added: 0, updated: 1, overCap: 1 });
    expect(await prisma.userTrackedWallet.count({ where: { userId: ids[0] } })).toBe(TRACKED_WALLET_CAP);
    expect(
      await prisma.userTrackedWallet.findUnique({
        where: { userId_wallet: { userId: ids[0]!, wallet: extra(1) } },
      }),
    ).toMatchObject({ name: "From file", category: "kol" });
    await prisma.userTrackedWallet.deleteMany({ where: { userId: ids[0], wallet: { not: LABELED } } });
    resetTrackedCache();
  });

  it("imports a list for a Pro Mode account: adds, renames, skips empty names, refuses others", async () => {
    const list = {
      wallets: [
        { wallet: extra(0), name: "  First  " },
        { wallet: extra(1), name: "\u200b" },
        { wallet: extra(0), name: "First again", kol: true },
        { wallet: LABELED, name: "Big Fish" },
        { wallet: extra(2), name: `x'); DROP TABLE "User";--` },
      ],
    };
    expect((await as(MEMBER, "POST", "/wallets/tracked/import", list)).statusCode).toBe(403);
    expect(
      (await as(ADMIN, "POST", "/wallets/tracked/import", { wallets: [{ wallet: "nope", name: "x" }] }))
        .statusCode,
    ).toBe(400);
    const res = await as(ADMIN, "POST", "/wallets/tracked/import", list);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      added: 2,
      updated: 1,
      overCap: 0,
      unnamed: 1,
      cap: TRACKED_WALLET_CAP,
    });
    // Names are data: stored and read back exactly, never run.
    expect((await as(ADMIN, "GET", "/wallets/tracked")).json().wallets).toContainEqual(
      expect.objectContaining({ wallet: extra(2), name: `x'); DROP TABLE "User";--` }),
    );
    const names = (await as(ADMIN, "POST", "/wallets/names", { wallets: [extra(0)] })).json().names;
    expect(names[extra(0)]).toEqual({ name: "First again", source: "kol", mine: true });
    // The import never reaches the shared side export.
    expect((await as(MEMBER, "GET", "/utilities/side-labels")).body).not.toContain(extra(0));
    await as(ADMIN, "DELETE", `/wallets/tracked/${extra(0)}`);
    await as(ADMIN, "DELETE", `/wallets/tracked/${extra(2)}`);
  });

  it("rejects imported labels on wallets TrenchScanner already labels, outside the cap", async () => {
    const known = await as(ADMIN, "POST", "/wallets/tracked/known", {
      wallets: [ROSTER_KOL, ROSTER_SIDE, extra(0), "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD"],
    });
    expect(known.statusCode).toBe(200);
    expect(known.json().known).toEqual([
      { wallet: ROSTER_KOL, label: "Roster Kol", kind: "kol" },
      { wallet: ROSTER_SIDE, label: "Roster Kol Known Side", kind: "kol-side" },
      { wallet: "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD", label: "Stonk_Fees", kind: "launchpad" },
    ]);
    // A label by hand is refused the same way, a new one or a rename alike.
    const manual = await as(ADMIN, "PUT", `/wallets/tracked/${ROSTER_KOL}`, { name: "Mine" });
    expect(manual.statusCode).toBe(409);
    expect(manual.json()).toMatchObject({
      error: "TrenchScanner already labels this wallet as Roster Kol.",
      known: { wallet: ROSTER_KOL, kind: "kol" },
    });
    expect((await as(ADMIN, "PUT", `/wallets/tracked/${ROSTER_SIDE}`, { name: "Mine" })).statusCode).toBe(
      409,
    );
    // One place left under the cap: the roster wallets take none of it.
    await prisma.userTrackedWallet.createMany({
      data: Array.from({ length: TRACKED_WALLET_CAP - 2 }, (_, i) => ({
        userId: ids[0]!,
        wallet: extra(i + 10),
        name: `W${i}`,
        category: "tracked",
      })),
    });
    resetTrackedCache();
    const res = await as(ADMIN, "POST", "/wallets/tracked/import", {
      wallets: [
        { wallet: ROSTER_KOL, name: "My name for them", kol: true },
        { wallet: ROSTER_SIDE, name: "Side" },
        { wallet: extra(0), name: "Fresh" },
      ],
    });
    expect(res.json()).toMatchObject({
      added: 1,
      updated: 0,
      overCap: 0,
      rejected: [
        { wallet: ROSTER_KOL, label: "Roster Kol", kind: "kol", name: "My name for them" },
        { wallet: ROSTER_SIDE, label: "Roster Kol Known Side", kind: "kol-side", name: "Side" },
      ],
    });
    expect(
      await prisma.userTrackedWallet.count({
        where: { userId: ids[0], wallet: { in: [ROSTER_KOL, ROSTER_SIDE] } },
      }),
    ).toBe(0);
    await prisma.userTrackedWallet.deleteMany({ where: { userId: ids[0], wallet: { not: LABELED } } });
    resetTrackedCache();
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
