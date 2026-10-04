// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";

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
        { ...base, tokenId: tokens.B, model: "trees", modelName: "Trees", createdAt: soon(5) },
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
});
