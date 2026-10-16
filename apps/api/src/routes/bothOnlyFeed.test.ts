// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import { calledNear } from "./matches.js";

/**
 * Settings' "Only alerts both caught" (PUT /curated/feed { bothOnly }): the Live feed and its
 * Stats keep only the reader's active filters' alerts on tokens a followed model also called
 * within the fold window, each one card wearing both.
 */

const ADMIN_WALLET = "BothOnlyFeedAdmin11111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `both-only-test-${Date.now()}`;
const HOUR = 3_600_000;

describe("calledNear", () => {
  it("matches a call on the same token within the window either side", () => {
    const t0 = new Date("2026-10-16T00:00:00Z");
    const near = calledNear([{ tokenId: "a", createdAt: new Date(t0.getTime() + 5 * HOUR) }], 6 * HOUR);
    expect(near("a", t0)).toBe(true);
    expect(near("a", new Date(t0.getTime() + 11 * HOUR))).toBe(true);
    expect(near("a", new Date(t0.getTime() - 2 * HOUR))).toBe(false);
    expect(near("b", t0)).toBe(false);
  });
});

describe.skipIf(!dbAvailable)("only alerts both caught", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET }
    : (undefined as never);
  let app: FastifyInstance;
  let cookie = "";
  let userId = "";
  const tokens: Record<"both" | "filterOnly" | "modelOnly" | "paused" | "farCall", string> = {
    both: "",
    filterOnly: "",
    modelOnly: "",
    paused: "",
    farCall: "",
  };
  const mine = (tokenId: string) => Object.values(tokens).includes(tokenId);

  const call = (method: "GET" | "PUT", url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as never, cookies: { [SESSION_COOKIE_NAME]: cookie } });

  type FeedCard = { tokenId: string; kind: string; curated: { model: string } | null };
  const myCards = async (extra = "") => {
    const res = await call("GET", `/matches?page=1&includeCurated=saved${extra}`);
    expect(res.statusCode).toBe(200);
    return (res.json() as { matches: FeedCard[] }).matches.filter((c) => mine(c.tokenId));
  };

  beforeAll(async () => {
    resetContestStateCache();
    userId = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: ADMIN_WALLET,
    });
    for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) {
      tokens[key] = (await prisma.token.create({ data: { mintAddress: `${TAG}-${key}` } })).id;
    }
    const active = await prisma.userFilter.create({
      data: { userId, name: `${TAG}-on`, mcapMin: 1, mcapMax: 1e9 },
    });
    const paused = await prisma.userFilter.create({
      data: { userId, name: `${TAG}-off`, mcapMin: 1, mcapMax: 1e9, isActive: false },
    });
    const now = Date.now();
    const matchAt = new Date(now - HOUR);
    const match = async (tokenId: string, filterId: string) => {
      const snapshot = await prisma.tokenSnapshot.create({
        data: { tokenId, priceUsd: 0.001, marketCapUsd: 100_000, score: 60 },
      });
      await prisma.match.create({
        data: { userId, filterId, tokenId, snapshotId: snapshot.id, matchedAt: matchAt, score: 60 },
      });
    };
    await match(tokens.both, active.id);
    await match(tokens.filterOnly, active.id);
    await match(tokens.paused, paused.id);
    await match(tokens.farCall, active.id);
    const base = { source: "test", confidence: 70, anchorPriceUsd: 0.0001, anchorMcapUsd: 50_000 };
    await prisma.curatedAlert.createMany({
      data: [
        {
          ...base,
          tokenId: tokens.both,
          model: "rules",
          modelName: "Rules",
          createdAt: new Date(now - 30 * 60_000),
        },
        {
          ...base,
          tokenId: tokens.modelOnly,
          model: "rules",
          modelName: "Rules",
          createdAt: new Date(now - HOUR),
        },
        {
          ...base,
          tokenId: tokens.paused,
          model: "rules",
          modelName: "Rules",
          createdAt: new Date(now - HOUR),
        },
        // Eight hours before the filter alert: past the fold window, so not the same event.
        {
          ...base,
          tokenId: tokens.farCall,
          model: "rules",
          modelName: "Rules",
          createdAt: new Date(now - 9 * HOUR),
        },
      ],
    });
    app = await buildServer(env);
    app.matchStream.dispatchCurated(JSON.stringify({ alertId: TAG }));
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("is off by default, and the feed shows either side's alerts", async () => {
    await call("PUT", "/curated/feed", { models: ["rules"], showModelAlerts: true });
    const board = (await call("GET", "/curated/models?days=30")).json() as { bothOnly: boolean };
    expect(board.bothOnly).toBe(false);
    // The far call is a card of its own beside its token's filter alert.
    const shown = new Set((await myCards()).map((c) => c.tokenId));
    expect([...shown].sort()).toEqual(Object.values(tokens).sort());
  });

  it("keeps only active filters' alerts a followed model also called, as one card wearing both", async () => {
    const res = await call("PUT", "/curated/feed", { bothOnly: true });
    expect(res.json()).toMatchObject({ bothOnly: true, showModelAlerts: true });
    const cards = await myCards();
    expect(cards.map((c) => [c.tokenId, c.kind, c.curated?.model])).toEqual([
      [tokens.both, "match", "rules"],
    ]);

    const stats = (await call("GET", "/matches/stats?hours=24")).json() as {
      alerts: number;
      bothOnly: boolean;
    };
    expect(stats).toMatchObject({ alerts: 1, bothOnly: true });
    const returns = await call("GET", "/matches/returns");
    expect(returns.statusCode).toBe(200);
    expect(returns.json()).toMatchObject({ bothOnly: true });
    const board = (await call("GET", "/curated/models?days=30")).json() as {
      bothOnly: boolean;
      feedCatch?: { bothOnly: boolean; filters: { count: number } };
    };
    expect(board.bothOnly).toBe(true);
    expect(board.feedCatch).toMatchObject({ bothOnly: true, filters: { count: 1 } });
  });

  it("narrows a search the same way", async () => {
    expect((await myCards(`&q=${TAG}-both`)).map((c) => c.tokenId)).toEqual([tokens.both]);
    expect(await myCards(`&q=${TAG}-filterOnly`)).toEqual([]);
  });

  it("doesn't apply while model alerts are off, and stays saved", async () => {
    await call("PUT", "/curated/feed", { showModelAlerts: false });
    const cards = await myCards();
    expect(cards.map((c) => c.tokenId).sort()).toEqual(
      [tokens.both, tokens.filterOnly, tokens.paused, tokens.farCall].sort(),
    );
    const stats = (await call("GET", "/matches/stats?hours=24")).json() as { bothOnly: boolean };
    expect(stats.bothOnly).toBe(false);
    const board = (await call("GET", "/curated/models?days=30")).json() as { bothOnly: boolean };
    expect(board.bothOnly).toBe(true);
  });
});
