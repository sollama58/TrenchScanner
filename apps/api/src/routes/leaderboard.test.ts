// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import type { FastifyInstance } from "fastify";

/**
 * The ranking is raw SQL (DISTINCT ON), so there is no pure function underneath to test instead.
 * CI provisions Postgres and applies migrations before `npm test`; this skips rather than fails
 * on a machine without a database.
 */
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `leaderboard-test-${Date.now()}`;

interface Entry {
  matchId: string;
  token: { id: string; symbol: string | null };
  returnPct: number | null;
}

describe.skipIf(!dbAvailable)("GET /leaderboard", () => {
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    const env = loadEnv();
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    userId = user.id;
    const filter = await prisma.userFilter.create({
      data: { userId, name: TAG, mcapMin: 10_000, mcapMax: 1_000_000 },
    });

    // Three tokens whose returns are deliberately awkward binary64 values, and one of them
    // carrying 80 near-duplicate matches - the shape that used to collapse the whole board to a
    // single entry when de-duplication happened after the row limit.
    const specs = [
      { symbol: "LOW", pct: 150.00000000000003, copies: 1 },
      { symbol: "MID", pct: 333.33333333333337, copies: 80 },
      { symbol: "TOP", pct: 755.5555555555557, copies: 1 },
      { symbol: "UNDER", pct: 42, copies: 1 }, // below +100%, must never appear
    ];

    for (const spec of specs) {
      const token = await prisma.token.create({
        data: { mintAddress: `${TAG}-${spec.symbol}`, symbol: spec.symbol, name: spec.symbol },
      });
      const snapshot = await prisma.tokenSnapshot.create({
        data: { tokenId: token.id, priceUsd: 0.001, marketCapUsd: 100_000, score: 60 },
      });
      for (let i = 0; i < spec.copies; i += 1) {
        await prisma.match.create({
          data: {
            userId,
            filterId: filter.id,
            tokenId: token.id,
            snapshotId: snapshot.id,
            matchedAt: new Date(Date.now() - i * 60_000),
            score: 60,
            peakMcapUsd: 100_000 * (1 + spec.pct / 100),
            peakMcapAt: new Date(),
            // Every copy but the first is very slightly worse, so "one entry per token" and
            // "that entry is the token's best" are distinguishable.
            peakReturnPct: i === 0 ? spec.pct : spec.pct - 0.0000001,
            hitHundredPctAt: spec.pct >= 100 ? new Date() : null,
          },
        });
      }
    }

    app = await buildServer(env);
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: user.walletAddress,
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.match.deleteMany({ where: { userId } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.userFilter.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function board(): Promise<Entry[]> {
    const res = await app.inject({
      method: "GET",
      url: "/leaderboard",
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { entries: Entry[] }).entries;
  }

  const ours = (entries: Entry[]) =>
    entries.filter((e) => e.token.symbol && ["LOW", "MID", "TOP", "UNDER"].includes(e.token.symbol));

  it("returns one entry per token however many matches that token has", async () => {
    const mine = ours(await board());
    const symbols = mine.map((e) => e.token.symbol);
    expect(symbols.filter((s) => s === "MID")).toHaveLength(1);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("picks each token's best-returning match, not an arbitrary one", async () => {
    // The 80 copies of MID are all 1e-7 worse than the first, so which row was selected is
    // observable. Compared with a tolerance rather than for equality on purpose: a Float does not
    // survive the trip through the driver and JSON bit-identically (333.33333333333337 comes back
    // as 333.3333333333334), which is harmless for a percentage on a card but is precisely why
    // this endpoint selects the winning row directly instead of looking it back up by its value.
    const mid = ours(await board()).find((e) => e.token.symbol === "MID");
    expect(mid?.returnPct).toBeGreaterThan(333.3333333);
    expect(mid?.returnPct).toBeCloseTo(333.3333333333, 9);
  });

  it("ranks by return, descending", async () => {
    const mine = ours(await board());
    expect(mine.map((e) => e.token.symbol)).toEqual(["TOP", "MID", "LOW"]);
  });

  it("excludes anything that never reached +100%", async () => {
    expect(ours(await board()).some((e) => e.token.symbol === "UNDER")).toBe(false);
  });

  it("requires a session", async () => {
    const res = await app.inject({ method: "GET", url: "/leaderboard" });
    expect(res.statusCode).toBe(401);
  });
});
