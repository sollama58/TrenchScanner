// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import { clearReaderCaches } from "./matches.js";

/**
 * The dashboard's combined feed: the user's own matches with the model calls they follow mixed
 * in (GET /matches?includeCurated=saved), driven by the settings PUT /curated/feed saves and
 * GET /curated/models reports back - the Live tab's checkboxes and the Models tab's.
 */

const ADMIN_WALLET = "CombinedFeedAdmin1111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `combined-feed-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("combined feed", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET }
    : (undefined as never);
  let app: FastifyInstance;
  let cookie = "";
  let userId = "";
  const tokens: Record<"A" | "B", string> = { A: "", B: "" };

  const call = (method: "GET" | "PUT", url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as never, cookies: { [SESSION_COOKIE_NAME]: cookie } });

  /** What the worker's NOTIFY does on arrival, for calls this file writes straight to the table. */
  const announceCalls = () => app.matchStream.dispatchCurated(JSON.stringify({ alertId: TAG }));

  /** This test's cards on the first page (other test files share the database). */
  const myCards = async () => {
    const res = await call("GET", "/matches?page=1&includeCurated=saved");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      matches: { tokenId: string; curated: { model: string; calledBy: { model: string }[] } | null }[];
    };
    return body.matches.filter((c) => c.tokenId === tokens.A || c.tokenId === tokens.B);
  };

  beforeAll(async () => {
    resetContestStateCache();
    userId = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: ADMIN_WALLET,
    });
    for (const key of ["A", "B"] as const) {
      tokens[key] = (await prisma.token.create({ data: { mintAddress: `${TAG}-${key}` } })).id;
    }
    // Dated just ahead of now so they sit on page 1 whatever else the database holds.
    const soon = (minutes: number) => new Date(Date.now() + 60_000 + minutes * 60_000);
    const base = { source: "test", confidence: 70, anchorPriceUsd: 0.0001, anchorMcapUsd: 50_000 };
    await prisma.curatedAlert.createMany({
      data: [
        { ...base, tokenId: tokens.A, model: "rules", modelName: "Rules", createdAt: soon(0) },
        { ...base, tokenId: tokens.A, model: "trees", modelName: "Trees", createdAt: soon(10) },
        // Over Trees' high-conviction line: the one call the high-conviction tier carries.
        { ...base, tokenId: tokens.B, model: "trees", modelName: "Trees", tier: "high", createdAt: soon(5) },
      ],
    });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("saves checked models in roster order and reports them on the leaderboard", async () => {
    const res = await call("PUT", "/curated/feed", { models: ["trees", "rules"] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ selectedModels: ["rules", "trees"], followsDefault: false });

    const board = (await call("GET", "/curated/models?days=30")).json() as {
      selectedModel: string;
      selectedModels: string[];
      showModelAlerts: boolean;
    };
    expect(board.selectedModels).toEqual(["rules", "trees"]);
    expect(board.selectedModel).toBe("rules");
    expect(board.showModelAlerts).toBe(true);
  });

  it("rejects a model that isn't on the roster", async () => {
    expect((await call("PUT", "/curated/feed", { models: ["nope"] })).statusCode).toBe(400);
  });

  it("shows a token several checked models called once, listing each model", async () => {
    await call("PUT", "/curated/feed", { models: ["rules", "trees"], showModelAlerts: true });
    const cards = await myCards();
    expect(cards.map((c) => c.tokenId).sort()).toEqual([tokens.A, tokens.B].sort());
    const a = cards.find((c) => c.tokenId === tokens.A)!;
    // The card is the first call; the later one is listed, not shown again.
    expect(a.curated!.model).toBe("rules");
    expect(a.curated!.calledBy.map((c) => c.model)).toEqual(["rules", "trees"]);
  });

  it("shows only the checked models' calls", async () => {
    await call("PUT", "/curated/feed", { models: ["rules"] });
    const cards = await myCards();
    expect(cards.map((c) => c.tokenId)).toEqual([tokens.A]);
    expect(cards[0]!.curated!.calledBy.map((c) => c.model)).toEqual(["rules"]);
  });

  it("shows the high-conviction tier alone on request, whatever models are checked", async () => {
    // Rules alone is checked (above), and Rules never called B; Trees' high call on B is the tier.
    const res = await call("GET", "/matches?page=1&includeCurated=saved&highConviction=1");
    expect(res.statusCode).toBe(200);
    const cards = (
      res.json() as { matches: { tokenId: string; curated: { model: string } | null }[] }
    ).matches.filter((c) => c.tokenId === tokens.A || c.tokenId === tokens.B);
    expect(cards.map((c) => [c.tokenId, c.curated?.model])).toEqual([[tokens.B, "trees"]]);
    // The tiles and returns read the same calls.
    expect((await call("GET", "/matches/stats?hours=24&highConviction=1")).statusCode).toBe(200);
    expect((await call("GET", "/matches/returns?highConviction=1")).statusCode).toBe(200);
    // Without the flag the feed is the checked models again.
    expect((await myCards()).map((c) => c.tokenId)).toEqual([tokens.A]);
  });

  it("leaves model calls out when the switch is off", async () => {
    const res = await call("PUT", "/curated/feed", { showModelAlerts: false });
    expect(res.json()).toMatchObject({ showModelAlerts: false });
    expect(await myCards()).toEqual([]);
  });

  it("keeps the single-model picker and the checkboxes in step", async () => {
    await call("PUT", "/curated/model", { model: "trees" });
    const board = (await call("GET", "/curated/models?days=30")).json() as { selectedModels: string[] };
    expect(board.selectedModels).toEqual(["trees"]);
  });

  it("pages on hasMore and fills in a card's calls from before what the page read", async () => {
    await call("PUT", "/curated/feed", { models: ["rules", "trees"], showModelAlerts: true });
    const later = (minutes: number) => new Date(Date.now() + 120 * 60_000 + minutes * 60_000);
    const base = { source: "test", confidence: 70, anchorPriceUsd: 0.0001, anchorMcapUsd: 50_000 };
    const late = (await prisma.token.create({ data: { mintAddress: `${TAG}-late` } })).id;
    const fillers: string[] = [];
    for (let i = 0; i < 12; i++) {
      fillers.push((await prisma.token.create({ data: { mintAddress: `${TAG}-fill-${i}` } })).id);
    }
    await prisma.curatedAlert.createMany({
      data: [
        // Called by Rules first, then by Trees after a dozen other tokens were called by both.
        { ...base, tokenId: late, model: "rules", modelName: "Rules", createdAt: later(0) },
        ...fillers.flatMap((tokenId, i) => [
          { ...base, tokenId, model: "rules", modelName: "Rules", createdAt: later(10 + i) },
          { ...base, tokenId, model: "trees", modelName: "Trees", createdAt: later(10 + i) },
        ]),
        { ...base, tokenId: late, model: "trees", modelName: "Trees", createdAt: later(60) },
      ],
    });
    // The worker announces every call it writes; the feed's shared call reads are cleared by it.
    announceCalls();

    const res = await call("GET", "/matches?page=1&includeCurated=saved");
    const body = res.json() as {
      hasMore: boolean;
      matches: { tokenId: string; curated: { model: string; calledBy: { model: string }[] } | null }[];
    };
    expect(body.hasMore).toBe(true);
    expect(body.matches).toHaveLength(12);
    // The card sits at Trees' call, at the top, but is Rules' first call, with both listed.
    expect(body.matches[0]!.tokenId).toBe(late);
    expect(body.matches[0]!.curated!.model).toBe("rules");
    expect(body.matches[0]!.curated!.calledBy.map((c) => c.model)).toEqual(["rules", "trees"]);
    // No token twice.
    expect(new Set(body.matches.map((c) => c.tokenId)).size).toBe(12);
  });

  it("folds a call into the filter alert before it even once that alert is on the next page", async () => {
    // User report 2026-10-25: a model call a minute after the reader's filter alert on the same
    // coin folded into it while both were on page 1. Once newer alerts pushed the filter alert onto
    // page 2, the call came back as a card of its own near the bottom of page 1, already minutes
    // old - a model alert that seemed to arrive late.
    await call("PUT", "/curated/feed", { models: ["rules"], showModelAlerts: true });
    const filter = await prisma.userFilter.create({
      data: { userId, name: `${TAG}-fold`, mcapMin: 1, mcapMax: 1e9 },
    });
    // Newer than anything else this file or the others date, so these are the first two pages.
    const at = (minutes: number) => new Date(Date.now() + 400 * 86_400_000 + minutes * 60_000);
    const match = async (tokenId: string, minutes: number) => {
      const snapshot = await prisma.tokenSnapshot.create({
        data: { tokenId, priceUsd: 0.001, marketCapUsd: 100_000, score: 60 },
      });
      return prisma.match.create({
        data: {
          userId,
          filterId: filter.id,
          tokenId,
          snapshotId: snapshot.id,
          matchedAt: at(minutes),
          score: 60,
        },
      });
    };
    const coin = (await prisma.token.create({ data: { mintAddress: `${TAG}-fold` } })).id;
    const twin = await match(coin, 0);
    await prisma.curatedAlert.create({
      data: {
        source: "test",
        confidence: 70,
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 50_000,
        tokenId: coin,
        model: "rules",
        modelName: "Rules",
        createdAt: at(1),
      },
    });
    announceCalls();
    // At first both are on page 1, one card: the filter alert wearing the call.
    const first = async (page: number) => {
      const res = await call("GET", `/matches?page=${page}&includeCurated=saved`);
      expect(res.statusCode).toBe(200);
      return (
        res.json() as {
          matches: { id: string; kind: string; tokenId: string; curated: { model: string } | null }[];
        }
      ).matches.filter((c) => c.tokenId === coin);
    };
    expect((await first(1)).map((c) => [c.id, c.curated?.model])).toEqual([[twin.id, "rules"]]);

    // Eleven newer filter alerts: the call is now the twelfth card and its filter alert the
    // thirteenth, on page 2.
    for (let i = 0; i < 11; i++) {
      const tokenId = (await prisma.token.create({ data: { mintAddress: `${TAG}-fold-${i}` } })).id;
      await match(tokenId, 2 + i);
    }
    clearReaderCaches(userId);
    expect(await first(1)).toEqual([]);
    expect((await first(2)).map((c) => [c.id, c.kind, c.curated?.model])).toEqual([
      [twin.id, "match", "rules"],
    ]);
  });

  it("reaches every match past the merge depth, none skipped and none twice", async () => {
    await call("PUT", "/curated/feed", { models: ["rules"], showModelAlerts: true });
    const filter = await prisma.userFilter.create({ data: { userId, name: TAG, mcapMin: 1, mcapMax: 1e9 } });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-deep` } });
    const snapshot = await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, priceUsd: 0.001, marketCapUsd: 100_000, score: 60 },
    });
    // 330 matches, older than anything else this file dates, one a minute; 40 model calls spread
    // through the same stretch so the first 300 merged items hold fewer than 300 matches.
    const start = Date.now() - 365 * 86_400_000;
    const at = (minutes: number) => new Date(start - minutes * 60_000);
    await prisma.match.createMany({
      data: Array.from({ length: 330 }, (_, i) => ({
        userId,
        filterId: filter.id,
        tokenId: token.id,
        snapshotId: snapshot.id,
        matchedAt: at(i),
        score: 60,
      })),
    });
    const called: string[] = [];
    for (let i = 0; i < 40; i++) {
      called.push((await prisma.token.create({ data: { mintAddress: `${TAG}-deep-call-${i}` } })).id);
    }
    await prisma.curatedAlert.createMany({
      data: called.map((tokenId, i) => ({
        source: "test",
        confidence: 70,
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 50_000,
        tokenId,
        model: "rules",
        modelName: "Rules",
        createdAt: at(i * 7 + 0.5),
      })),
    });
    // The worker announces every call it writes; the feed's shared call reads are cleared by it.
    announceCalls();

    const seen: string[] = [];
    let page = 1;
    for (; page <= 80; page++) {
      const res = await call("GET", `/matches?page=${page}&includeCurated=saved`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { hasMore: boolean; matches: { id: string; tokenId: string }[] };
      seen.push(...body.matches.filter((c) => c.tokenId === token.id).map((c) => c.id));
      if (!body.hasMore) break;
    }
    expect(page).toBeLessThan(80);
    expect(seen).toHaveLength(330);
    expect(new Set(seen).size).toBe(330);
  });
});
