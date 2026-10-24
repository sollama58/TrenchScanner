// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isWalletAddress, loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import { resetTrackedCache } from "../trackedWallets.js";

/**
 * A wallet address from a readable prefix (no 0, O, I or l): the first fill that lands on the
 * curve, since the maps keep only addresses someone can hold a key for.
 */
const addr = (prefix: string) => {
  for (const c of "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz") {
    const a = prefix + c.repeat(43 - prefix.length);
    if (isWalletAddress(a)) return a;
  }
  throw new Error(`no wallet address for ${prefix}`);
};
const ADMIN = addr("AsyAdmin");
const PLAIN = addr("AsyGuest");
const FUNDER = addr("AsyFunder");
const A = addr("AsyWaA");
const B = addr("AsyWaB");
const C = addr("AsyWaC");
const DEV = addr("AsyDev");
const MINT1 = addr("AsyMntUnopump");
const MINT2 = addr("AsyMntTwopump");
const WALLETS = [ADMIN, PLAIN, FUNDER, A, B, C, DEV];
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("asyl routes", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN, HELIUS_API_KEY: "" }
    : (undefined as never);
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const userIds: string[] = [];

  const as = (who: string | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, cookies: who ? { [SESSION_COOKIE_NAME]: cookies[who]! } : {} });

  const cleanup = async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { in: [MINT1, MINT2] } } });
    await prisma.walletFunder.deleteMany({ where: { wallet: { in: WALLETS } } });
    await prisma.holderTransferEvent.deleteMany({ where: { fromWallet: { in: WALLETS } } });
    await prisma.userTrackedWallet.deleteMany({ where: { wallet: { in: WALLETS } } });
    await prisma.asylMap.deleteMany({ where: { userId: { in: userIds } } });
  };

  beforeAll(async () => {
    resetContestStateCache();
    resetTrackedCache();
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    for (const wallet of [ADMIN, PLAIN]) {
      const user = await prisma.user.upsert({
        where: { walletAddress: wallet },
        update: {},
        create: { walletAddress: wallet },
      });
      userIds.push(user.id);
      cookies[wallet] = await signer.sign({ userId: user.id, walletAddress: wallet });
    }
    await cleanup();
    const day = new Date(Date.now() - 86_400_000);
    await prisma.walletFunder.createMany({
      data: [
        { wallet: A, status: "found", funder: FUNDER, amountSol: 1.5, fundedAt: day },
        { wallet: B, status: "found", funder: FUNDER, amountSol: 0.5, fundedAt: day },
        { wallet: C, status: "found", funder: A, amountSol: 0.2, fundedAt: day },
      ],
    });
    const t1 = await prisma.token.create({ data: { mintAddress: MINT1, symbol: "ONE", creator: DEV } });
    const t2 = await prisma.token.create({ data: { mintAddress: MINT2, symbol: "TWO" } });
    const at = new Date(Date.now() - 3_600_000);
    const later = new Date(at.getTime() + 60_000);
    await prisma.tokenWalletActivity.createMany({
      data: [
        { tokenId: t1.id, wallet: A, buys: 1, solIn: 1, firstBuyAt: at },
        { tokenId: t1.id, wallet: B, buys: 1, solIn: 1, firstBuyAt: later },
        { tokenId: t2.id, wallet: A, buys: 1, solIn: 1, firstBuyAt: at },
        { tokenId: t2.id, wallet: B, buys: 1, solIn: 1, firstBuyAt: later },
      ],
    });
    await prisma.holderTransferEvent.create({
      data: { signature: "asyl-sig-1", fromWallet: A, toWallet: B, mintAddress: MINT1, pct: 1.2, at },
    });
    await prisma.bubbleMapHolders.create({
      data: {
        mintAddress: MINT1,
        readAt: at,
        holdersRead: 2,
        knownExtra: 0,
        holders: [
          { wallet: A, pct: 4 },
          { wallet: B, pct: 3 },
        ],
        clusters: [],
        sameTimeClusters: [],
        computedAt: at,
      },
    });
    await prisma.userTrackedWallet.create({
      data: { userId: userIds[0]!, wallet: A, name: "Alpha", category: "tracked" },
    });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.bubbleMapHolders.deleteMany({ where: { mintAddress: MINT1 } });
    await cleanup();
  });

  it("needs a session, but no subscription", async () => {
    expect((await as(null, "GET", "/asyl/me")).statusCode).toBe(401);
    const me = await as(PLAIN, "GET", "/asyl/me");
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ wallet: PLAIN, pro: false, chain: null });
    const admin = await as(ADMIN, "GET", "/asyl/me");
    expect(admin.json()).toMatchObject({ pro: true, chain: { enabled: true, used: 0, cap: 3000 } });
  });

  it("maps a wallet's funder, siblings, funded wallets, transfers, coins and co-traders", async () => {
    const res = await as(PLAIN, "GET", `/asyl/wallet/${A}`);
    expect(res.statusCode).toBe(200);
    const { graph, coverage } = res.json() as {
      graph: {
        nodes: { id: string; name: string | null; tags: string[] }[];
        edges: { a: string; b: string; kind: string }[];
      };
      coverage: { seen: number };
    };
    const has = (a: string, b: string, kind: string) =>
      graph.edges.some((e) => e.a === a && e.b === b && e.kind === kind);
    expect(has(FUNDER, A, "funded")).toBe(true);
    expect(has(FUNDER, B, "funded")).toBe(true);
    expect(has(A, C, "funded")).toBe(true);
    expect(has(A, B, "transfer")).toBe(true);
    expect(has(A, MINT1, "traded")).toBe(true);
    expect(
      graph.edges.some((e) => e.kind === "cotrade" && [e.a, e.b].includes(A) && [e.a, e.b].includes(B)),
    ).toBe(true);
    expect(coverage.seen).toBe(2);
    // Someone else's label never shows.
    expect(graph.nodes.find((n) => n.id === A)?.name).toBeNull();
  });

  it("lays the reader's own label over the wallet for Pro Mode", async () => {
    const res = await as(ADMIN, "GET", `/asyl/wallet/${A}`);
    const node = (
      res.json() as { graph: { nodes: { id: string; name: string; tags: string[] }[] } }
    ).graph.nodes.find((n) => n.id === A);
    expect(node).toMatchObject({ name: "Alpha" });
    expect(node?.tags).toContain("mine");
    const map = await as(ADMIN, "GET", "/asyl/labels/map");
    expect((map.json() as { graph: { nodes: { id: string }[] } }).graph.nodes.map((n) => n.id)).toContain(A);
  });

  it("maps a coin's holders with its creator", async () => {
    const res = await as(PLAIN, "GET", `/asyl/token/${MINT1}`);
    expect(res.statusCode).toBe(200);
    const { graph } = res.json() as {
      graph: {
        nodes: { id: string; name: string | null }[];
        edges: { a: string; b: string; kind: string }[];
      };
    };
    expect(
      graph.edges
        .filter((e) => e.kind === "holds")
        .map((e) => e.a)
        .sort(),
    ).toEqual([A, B].sort());
    expect(graph.edges.some((e) => e.a === DEV && e.kind === "created")).toBe(true);
    expect(graph.edges.some((e) => e.a === FUNDER && e.b === A && e.kind === "funded")).toBe(true);
    expect(graph.nodes.find((n) => n.id === MINT1)?.name).toBe("$ONE");
  });

  it("links what is on the map already, with each coin's deployer when asked", async () => {
    type Read = { graph: { nodes: { id: string; deployer?: string | null }[]; edges: Edge[] } };
    type Edge = { a: string; b: string; kind: string; label: string };
    const has = (r: Read, a: string, b: string, kind: string) =>
      r.graph.edges.some((e) => e.a === a && e.b === b && e.kind === kind);
    const among = (
      await as(PLAIN, "POST", "/asyl/links", { wallets: [A, B, C], tokens: [MINT1] })
    ).json() as Read;
    expect(has(among, A, B, "transfer")).toBe(true);
    expect(has(among, A, C, "funded")).toBe(true);
    expect(has(among, A, MINT1, "traded")).toBe(true);
    // FUNDER and DEV aren't on the map: nothing ties to them.
    expect(among.graph.edges.some((e) => e.a === FUNDER || e.a === DEV)).toBe(false);
    expect(among.graph.nodes.find((n) => n.id === MINT1)?.deployer).toBe(DEV);

    const withDev = (
      await as(PLAIN, "POST", "/asyl/links", { wallets: [A], tokens: [MINT1, MINT2], deployers: true })
    ).json() as Read;
    expect(withDev.graph.edges.find((e) => e.a === DEV && e.b === MINT1)).toMatchObject({
      kind: "created",
      label: expect.stringMatching(/^Deployed/),
    });
    expect((await as(PLAIN, "POST", "/asyl/links", { wallets: ["nope"] })).statusCode).toBe(400);
  });

  it("keeps chain reads and labels to Pro Mode", async () => {
    expect((await as(PLAIN, "POST", `/asyl/chain/flows/${A}`)).statusCode).toBe(403);
    expect((await as(PLAIN, "PUT", `/asyl/labels/${B}`, { name: "Beta" })).statusCode).toBe(403);
    // Pro, but this server has no Helius key.
    expect((await as(ADMIN, "POST", `/asyl/chain/flows/${A}`)).statusCode).toBe(503);
    const put = await as(ADMIN, "PUT", `/asyl/labels/${B}`, { name: "Beta" });
    expect(put.statusCode).toBe(200);
    expect((await as(ADMIN, "DELETE", `/asyl/labels/${B}`)).json()).toEqual({ removed: true });
  });

  it("saves, shares and unshares a map, the shared copy frozen and public", async () => {
    const doc = {
      v: 1,
      nodes: [
        { id: A, kind: "wallet", name: "Alpha", tags: ["mine"] },
        { id: B, kind: "wallet", name: null, tags: [] },
      ],
      edges: [{ a: A, b: B, kind: "transfer", weight: 1, label: "Sent", source: "stored" }],
      positions: { [A]: [0, 0], [B]: [10, 5], [C]: [1, 1] },
      notes: { [A]: "the hub" },
    };
    const created = await as(PLAIN, "POST", "/asyl/maps", { title: "Case one", doc });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { map: { id: string } }).map.id;
    const read = await as(PLAIN, "GET", `/asyl/maps/${id}`);
    // Positions of nodes not on the map are dropped.
    expect(Object.keys((read.json() as { doc: { positions: object } }).doc.positions).sort()).toEqual(
      [A, B].sort(),
    );
    expect((await as(ADMIN, "GET", `/asyl/maps/${id}`)).statusCode).toBe(404);

    // Taken off the map: kept in the saved map, left out of the shared copy.
    await as(PLAIN, "PUT", `/asyl/maps/${id}`, { title: "Case one", doc: { ...doc, removed: [B] } });
    expect((await as(PLAIN, "GET", `/asyl/maps/${id}`)).json()).toMatchObject({ doc: { removed: [B] } });
    const { slug } = (await as(PLAIN, "POST", `/asyl/maps/${id}/share`)).json() as { slug: string };
    const frozen = (await as(null, "GET", `/asyl/shared/${slug}`)).json() as {
      doc: { nodes: { id: string }[]; edges: unknown[] };
    };
    expect(frozen.doc.nodes.map((n) => n.id)).toEqual([A]);
    expect(frozen.doc.edges).toEqual([]);
    expect(slug).toMatch(/^[A-Za-z0-9]{12}$/);
    await as(PLAIN, "PUT", `/asyl/maps/${id}`, { title: "Case one, edited", doc: { ...doc, notes: {} } });
    const shared = await as(null, "GET", `/asyl/shared/${slug}`);
    expect(shared.statusCode).toBe(200);
    expect(shared.json()).toMatchObject({ doc: { notes: { [A]: "the hub" } } });

    expect((await as(PLAIN, "DELETE", `/asyl/maps/${id}/share`)).json()).toEqual({ unshared: true });
    expect((await as(null, "GET", `/asyl/shared/${slug}`)).statusCode).toBe(404);
    expect((await as(PLAIN, "DELETE", `/asyl/maps/${id}`)).json()).toEqual({ removed: true });
  });
});
