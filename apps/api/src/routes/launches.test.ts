// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

/** GET /launches - the dashboard's Stream of tokens that passed the safety screen in the band. */

const ADMIN_WALLET = "LaunchStreamAdmin1111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `launch-stream-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("GET /launches", () => {
  const env: Env = dbAvailable
    ? {
        ...loadEnv(),
        ADMIN_WALLET_ADDRESSES: ADMIN_WALLET,
        MCAP_FILTER_MIN: 10_000,
        MCAP_FILTER_MAX: 1_000_000,
      }
    : (undefined as never);
  let app: FastifyInstance;
  let cookie = "";
  let userId = "";
  const ids: Record<string, string> = {};

  /** A token that entered the band `ago` ms ago, with scan snapshots at the given offsets. */
  const token = async (
    name: string,
    ago: number,
    snaps: { at: number; mcap: number; passed: boolean; source?: string; graduated?: boolean }[],
  ) => {
    const now = Date.now();
    const t = await prisma.token.create({
      data: { mintAddress: `${TAG}-${name}`, symbol: name, firstInBandAt: new Date(now - ago) },
    });
    for (const s of snaps)
      await prisma.tokenSnapshot.create({
        data: {
          tokenId: t.id,
          takenAt: new Date(now - s.at),
          priceUsd: s.mcap / 1e9,
          marketCapUsd: s.mcap,
          rugScreenPassed: s.passed,
          source: s.source ?? "scan",
          graduated: s.graduated ?? null,
        },
      });
    ids[name] = t.id;
  };

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: ADMIN_WALLET,
    });
    // Passed in the band two minutes ago, and still passing.
    await token("older", 180_000, [
      { at: 120_000, mcap: 15_000, passed: true },
      { at: 30_000, mcap: 40_000, passed: true },
    ]);
    // Entered the band failing, then passed a minute later: on the Stream from that pass.
    await token("newer", 240_000, [
      { at: 240_000, mcap: 12_000, passed: false },
      { at: 60_000, mcap: 20_000, passed: true },
    ]);
    // Never passed.
    await token("failing", 60_000, [{ at: 60_000, mcap: 20_000, passed: false }]);
    // Passed on the way in, failed since.
    await token("rugged", 90_000, [
      { at: 90_000, mcap: 20_000, passed: true },
      { at: 10_000, mcap: 5_000, passed: false },
    ]);
    // Passed only under the band floor.
    await token("under", 60_000, [{ at: 60_000, mcap: 8_000, passed: true }]);
    // A fast-pass row restates a verdict; it doesn't make one.
    await token("fastOnly", 60_000, [{ at: 60_000, mcap: 20_000, passed: true, source: "fast" }]);
    // Passed on its curve, then graduated and passed again: on the graduated list from that pass.
    await token("grad", 300_000, [
      { at: 300_000, mcap: 30_000, passed: true, graduated: false },
      { at: 50_000, mcap: 90_000, passed: true, graduated: true },
    ]);
    // First met already graduated (an old coin someone looked up): not freshly graduated.
    await token("oldGrad", 100_000, [{ at: 100_000, mcap: 200_000, passed: true, graduated: true }]);
    // On its curve at 60K now: about to graduate.
    await token("soonish", 200_000, [
      { at: 200_000, mcap: 20_000, passed: true, graduated: false },
      { at: 20_000, mcap: 60_000, passed: true, graduated: false },
    ]);
    // Scanned at 30K, but its live market cap since is 50K: about to graduate too.
    await token("liveSoon", 200_000, [{ at: 100_000, mcap: 30_000, passed: true }]);
    await prisma.token.update({
      where: { id: ids.liveSoon },
      data: { liveMarketCapUsd: 50_000, liveDataAt: new Date() },
    });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.token.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("lists the tokens that passed the screen inside the band, newest pass first", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/launches",
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      launches: {
        kind: string;
        tokenId: string;
        snapshot: { marketCapUsd: number };
        latestSnapshot: { marketCapUsd: number } | null;
        filter: null;
        curated: null;
      }[];
    };
    const mine = body.launches.filter((c) => Object.values(ids).includes(c.tokenId));
    expect(mine.map((c) => c.tokenId)).toEqual([
      ids.newer,
      ids.liveSoon,
      ids.oldGrad,
      ids.older,
      ids.soonish,
      ids.grad,
    ]);
    // The card's Alert figure is the market cap it passed at; Now comes from the newest scan.
    expect(mine[3]).toMatchObject({
      kind: "stream",
      snapshot: { marketCapUsd: 15_000 },
      latestSnapshot: { marketCapUsd: 40_000 },
      filter: null,
      curated: null,
    });
  });

  it("says whether an older page has anything, and pages back", async () => {
    const get = (url: string) =>
      app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookie } });
    const first = (await get("/launches")).json() as { page: number; hasMore: boolean };
    expect(first.page).toBe(1);
    expect(typeof first.hasMore).toBe("boolean");
    const deep = await get("/launches?page=10");
    expect(deep.statusCode).toBe(200);
    expect((deep.json() as { hasMore: boolean }).hasMore).toBe(false);
    expect((await get("/launches?page=11")).statusCode).toBe(400);
    expect((await get("/launches?page=0")).statusCode).toBe(400);
  });

  it("narrows to one token by its address", async () => {
    const get = (url: string) =>
      app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookie } });
    const older = await prisma.token.update({
      where: { id: ids.older },
      data: { mintAddress: "LaunchSearchMint1111111111111111111111111111" },
    });
    const found = (await get(`/launches?mint=${older.mintAddress}`)).json() as {
      launches: { tokenId: string }[];
      hasMore: boolean;
    };
    expect(found.launches.map((c) => c.tokenId)).toEqual([ids.older]);
    expect(found.hasMore).toBe(false);
    // Never passed: not on the Stream, searched or not.
    const failing = await prisma.token.update({
      where: { id: ids.failing },
      data: { mintAddress: "LaunchSearchMint2222222222222222222222222222" },
    });
    expect(
      ((await get(`/launches?mint=${failing.mintAddress}`)).json() as { launches: unknown[] }).launches,
    ).toEqual([]);
    expect((await get("/launches?mint=not-an-address")).statusCode).toBe(400);
  });

  it("finds tokens by ticker, name or part of the address", async () => {
    const get = (url: string) =>
      app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookie } });
    const found = (await get("/launches?q=%24NEWE")).json() as { launches: { tokenId: string }[] };
    expect(found.launches.map((c) => c.tokenId)).toEqual([ids.newer]);
    // A % in the text is a character, not a wildcard.
    expect(((await get("/launches?q=%25%25")).json() as { launches: unknown[] }).launches).toEqual([]);
  });

  it("lists only graduated tokens, from their first pass after graduating", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/launches?graduated=1",
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      launches: {
        tokenId: string;
        snapshot: { marketCapUsd: number };
        streamEntry?: string;
        firstPass?: { mcapUsd: number } | null;
      }[];
    };
    const mine = body.launches.filter((c) => Object.values(ids).includes(c.tokenId));
    // oldGrad was never seen on its curve: not freshly graduated.
    expect(mine.map((c) => c.tokenId)).toEqual([ids.grad]);
    expect(mine[0]?.snapshot.marketCapUsd).toBe(90_000);
    // Its first pass on the curve rides along, so the card can say when it really passed.
    expect(mine[0]?.streamEntry).toBe("graduated");
    expect(mine[0]?.firstPass?.mcapUsd).toBe(30_000);
  });

  it("is behind sign-in like the feeds", async () => {
    expect((await app.inject({ method: "GET", url: "/launches" })).statusCode).toBe(401);
  });

  it("spends the text search budget on a typed search, never on the Stream's own pages", async () => {
    // Its own account, so the searches above don't count against it.
    const wallet = "LaunchStreamSearcher11111111111111111111111";
    const searcher = await prisma.user.create({ data: { walletAddress: wallet } });
    await prisma.whitelist.create({ data: { walletAddress: wallet, addedBy: ADMIN_WALLET } });
    const own = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: searcher.id,
      walletAddress: wallet,
    });
    const ask = (url: string) => app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: own } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 31; i++)
        codes.push((await ask(`/launches?graduated=1&page=10&q=a${i}`)).statusCode);
      expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
      expect(codes[30]).toBe(429);
      // The Stream itself, and a token by its address, are cached reads: still answered.
      expect((await ask("/launches")).statusCode).toBe(200);
      expect((await ask(`/launches?mint=${"1".repeat(32)}`)).statusCode).toBe(200);
    } finally {
      await prisma.whitelist.deleteMany({ where: { walletAddress: wallet } });
      await prisma.user.deleteMany({ where: { id: searcher.id } });
    }
  });
});
