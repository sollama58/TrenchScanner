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
    snaps: { at: number; mcap: number; passed: boolean; source?: string }[],
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
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
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
    expect(mine.map((c) => c.tokenId)).toEqual([ids.newer, ids.older]);
    // The card's Alert figure is the market cap it passed at; Now comes from the newest scan.
    expect(mine[1]).toMatchObject({
      kind: "stream",
      snapshot: { marketCapUsd: 15_000 },
      latestSnapshot: { marketCapUsd: 40_000 },
      filter: null,
      curated: null,
    });
  });

  it("is behind sign-in like the feeds", async () => {
    expect((await app.inject({ method: "GET", url: "/launches" })).statusCode).toBe(401);
  });
});
