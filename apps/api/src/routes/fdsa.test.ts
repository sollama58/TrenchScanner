// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FDSA_DESK_CONFIG,
  FDSA_DEFAULT_EXIT_PLAN,
  FDSA_DESK_ID,
  loadEnv,
  prisma,
  type Env,
} from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

// FDSA's hidden tab API (routes/fdsa.ts; owner decision 2026-10-31): admin wallets only, paper
// only, and a record read honestly off the alerts' own grades.

const ADMIN_WALLET = "FdsaAdmin1111111111111111111111111111111111";
const OTHER_WALLET = "FdsaNotAdmin111111111111111111111111111111";
const TAG = "fdsa-route-test";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };

type Method = "GET" | "POST" | "PATCH";
async function call(method: Method, url: string, as: "admin" | "other" | "nobody", payload?: object) {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie =
      as === "nobody"
        ? null
        : await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
            userId: userIds[as],
            walletAddress: as === "admin" ? ADMIN_WALLET : OTHER_WALLET,
          });
    return await app.inject({
      method,
      url,
      ...(cookie ? { cookies: { [SESSION_COOKIE_NAME]: cookie } } : {}),
      ...(payload !== undefined ? { payload } : {}),
    });
  } finally {
    await app.close();
  }
}

let seq = 0;
/** An alerted token with its outcome row: won (a clean 2x), lost, or still in its window. */
async function alerted(grade: "won" | "won4x" | "lost" | "open", simReturnPct: number | null = null) {
  const token = await prisma.token.create({
    data: { mintAddress: `${TAG}-${++seq}-${Math.random()}`, symbol: `T${seq}` },
  });
  const graded = grade !== "open";
  const outcome = await prisma.candidateOutcome.create({
    data: {
      tokenId: token.id,
      anchorPriceUsd: 1,
      anchorMcapUsd: 50_000,
      features: {},
      nextCheckAt: new Date(),
      peak1hPriceUsd: 1,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      peak24hPriceUsd: 1,
      sampleKind: "event",
      finalizedAt: graded ? new Date() : null,
      labelValue: graded ? (grade === "lost" ? 0 : grade === "won4x" ? 2.2 : 1.1) : null,
      hit4xIn1h: graded ? grade === "won4x" : null,
      simReturnPct,
    },
  });
  return { token, outcome };
}

async function review(
  a: Awaited<ReturnType<typeof alerted>>,
  stage: "screen" | "decide",
  decision: string | null,
  extra: { reasoning?: string; error?: string } = {},
) {
  return prisma.fdsaReview.create({
    data: {
      tokenId: a.token.id,
      candidateOutcomeId: a.outcome.id,
      stage,
      dedupeKey: `${a.token.id}:${stage}`,
      model: stage === "screen" ? "claude-haiku-5-5" : "claude-opus-5-5",
      effort: stage === "screen" ? "low" : "medium",
      promptVersion: "fdsa-v1",
      decision,
      score: stage === "screen" ? 0.8 : null,
      probability2x: stage === "decide" ? 0.4 : null,
      exitPlan: stage === "decide" && decision === "trade" ? FDSA_DEFAULT_EXIT_PLAN : undefined,
      reasoning: extra.reasoning ?? null,
      error: extra.error ?? null,
      costUsd: 0.01,
      latencyMs: 1_000,
      alertAt: new Date(),
      anchorPriceUsd: 1,
      anchorMcapUsd: 50_000,
    },
  });
}

async function position(
  a: Awaited<ReturnType<typeof alerted>>,
  opts: { status: "open" | "closed"; proceedsSol?: number; floor?: number },
) {
  const now = Date.now();
  return prisma.fdsaPosition.create({
    data: {
      deskId: FDSA_DESK_ID,
      mint: a.token.mintAddress,
      symbol: a.token.symbol,
      tokenId: a.token.id,
      candidateOutcomeId: a.outcome.id,
      signalAt: new Date(now - 60_000),
      verdictAt: new Date(now - 40_000),
      openedAt: new Date(now - 30_000),
      status: opts.status,
      swapInLamports: 500_000_000n,
      feesLamports: 0n,
      proceedsLamports: BigInt(Math.round((opts.proceedsSol ?? 0) * 1e9)),
      tokensBought: "1000",
      tokensHeld: opts.status === "open" ? "1000" : "0",
      decimals: 6,
      exitPlan: FDSA_DEFAULT_EXIT_PLAN,
      floorMultiple: opts.floor ?? 0.5,
      lastMultiple: 1.2,
      closedAt: opts.status === "closed" ? new Date() : null,
      closeReason: opts.status === "closed" ? "floor" : null,
      revisions: {
        create: [{ trigger: "entry", status: "applied", version: 1, plan: FDSA_DEFAULT_EXIT_PLAN }],
      },
    },
  });
}

async function clear() {
  await prisma.fdsaDesk.deleteMany({});
  await prisma.fdsaReview.deleteMany({});
  await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
}

describe.skipIf(!dbAvailable)("FDSA routes", () => {
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
    userIds.admin = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    userIds.other = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
  });
  beforeEach(clear);
  afterAll(async () => {
    if (!dbAvailable) return;
    await clear();
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
  });

  it("answers no one but an admin wallet, and changes nothing for them (decision 7)", async () => {
    const routes: [Method, string, object?][] = [
      ["GET", "/fdsa"],
      ["PATCH", "/fdsa", { running: true }],
      ["POST", "/fdsa/reset", {}],
      ["POST", "/fdsa/positions/x/close", {}],
      ["GET", "/fdsa/positions"],
      ["GET", "/fdsa/record"],
      ["GET", "/fdsa/reviews"],
    ];
    for (const [method, url, body] of routes) {
      expect((await call(method, url, "other", body)).statusCode, `${method} ${url}`).toBe(403);
      expect((await call(method, url, "nobody", body)).statusCode, `${method} ${url}`).toBe(401);
    }
    expect(await prisma.fdsaDesk.count()).toBe(0);
  });

  it("starts the desk paused, on paper, with the owner's paper defaults", async () => {
    const res = await call("GET", "/fdsa", "admin");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.desk).toMatchObject({
      mode: "paper",
      running: false,
      bankrollLamports: "10000000000",
      cashLamports: "10000000000",
      config: { buySol: 0.5, maxOpenPositions: 6, maxDailySpendSol: 100 },
    });
    expect(body.desk.modes).toEqual([
      { id: "paper", available: true },
      { id: "live", available: false },
    ]);
    expect(body.budget).toMatchObject({ spentUsd: 0, reviewsStopped: false });
    expect(body.reviews.today).toMatchObject({ screened: 0, shortlistRate: null });
  });

  it("refuses Live, and resumes, pauses and edits the paper limits", async () => {
    const live = await call("PATCH", "/fdsa", "admin", { mode: "live" });
    expect(live.statusCode).toBe(400);
    expect(live.json().error).toMatch(/not available/);
    expect((await call("PATCH", "/fdsa", "admin", { mode: "wild" })).statusCode).toBe(400);

    const before = Date.now();
    const on = await call("PATCH", "/fdsa", "admin", {
      running: true,
      config: { ...DEFAULT_FDSA_DESK_CONFIG, maxOpenPositions: 3 },
    });
    expect(on.statusCode, on.body).toBe(200);
    const desk = await prisma.fdsaDesk.findUniqueOrThrow({ where: { id: FDSA_DESK_ID } });
    expect(desk).toMatchObject({ running: true, mode: "paper", updatedBy: ADMIN_WALLET });
    expect((desk.config as { maxOpenPositions: number }).maxOpenPositions).toBe(3);
    // Starting never trades a backlog.
    expect(desk.signalsFrom.getTime()).toBeGreaterThanOrEqual(before - 1000);

    // A limit the schema refuses is a 400 and leaves the saved one.
    const bad = await call("PATCH", "/fdsa", "admin", {
      config: { ...DEFAULT_FDSA_DESK_CONFIG, buySol: -1 },
    });
    expect(bad.statusCode).toBe(400);

    await prisma.fdsaDesk.update({ where: { id: FDSA_DESK_ID }, data: { pausedReason: "daily loss limit" } });
    expect((await call("PATCH", "/fdsa", "admin", { running: false })).statusCode).toBe(200);
    expect(await prisma.fdsaDesk.findUniqueOrThrow({ where: { id: FDSA_DESK_ID } })).toMatchObject({
      running: false,
      pausedReason: null,
    });
  });

  it("resets the paper bankroll only with nothing open, and keeps the history", async () => {
    await call("GET", "/fdsa", "admin");
    const a = await alerted("won", 80);
    const p = await position(a, { status: "open" });
    const refused = await call("POST", "/fdsa/reset", "admin", { bankrollSol: 20 });
    expect(refused.statusCode).toBe(409);

    const closed = await call("POST", `/fdsa/positions/${p.id}/close`, "admin", {});
    expect(closed.statusCode).toBe(200);
    expect((await prisma.fdsaPosition.findUniqueOrThrow({ where: { id: p.id } })).closeRequested).toBe(true);
    await prisma.fdsaPosition.update({
      where: { id: p.id },
      data: { status: "closed", closedAt: new Date() },
    });
    expect((await call("POST", `/fdsa/positions/${p.id}/close`, "admin", {})).statusCode).toBe(404);

    const ok = await call("POST", "/fdsa/reset", "admin", { bankrollSol: 20 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await prisma.fdsaDesk.findUniqueOrThrow({ where: { id: FDSA_DESK_ID } })).toMatchObject({
      bankrollLamports: 20_000_000_000n,
      cashLamports: 20_000_000_000n,
    });
    expect(await prisma.fdsaPosition.count({ where: { id: p.id } })).toBe(1);
  });

  it("shows open positions with their plan, floor and history, and closed ones with P&L", async () => {
    await call("GET", "/fdsa", "admin");
    await position(await alerted("open"), { status: "open", floor: 1 });
    await position(await alerted("won", 40), { status: "closed", proceedsSol: 1 });
    const res = await call("GET", "/fdsa/positions", "admin");
    expect(res.statusCode, res.body).toBe(200);
    const { open, closed } = res.json();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      floorMultiple: 1,
      planVersion: 1,
      plan: FDSA_DEFAULT_EXIT_PLAN,
      hit2x: null,
      verdictLatencyMs: 20_000,
      fillLatencyMs: 30_000,
    });
    expect(open[0].revisions).toEqual([expect.objectContaining({ trigger: "entry", status: "applied" })]);
    expect(closed[0]).toMatchObject({
      pnlLamports: "500000000",
      pnlPct: 100,
      closeReason: "floor",
      hit2x: true,
      ladderReturnPct: 40,
    });
  });

  it("reports the record on trades, verdicts and passes with samples, the pool and the ladder", async () => {
    await call("GET", "/fdsa", "admin");
    // Pool: 5 screened, 2 of them winners (40%). 2 shortlisted; one traded (won), one passed (lost).
    const traded = await alerted("won4x", 50);
    const passed = await alerted("lost");
    const dropped = [await alerted("won"), await alerted("lost"), await alerted("lost")];
    const pending = await alerted("open");
    await review(traded, "screen", "shortlist");
    await review(passed, "screen", "shortlist");
    for (const d of dropped) await review(d, "screen", "drop");
    await review(pending, "screen", null, { error: "timeout" });
    await review(traded, "decide", "trade", { reasoning: "fresh narrative, <b>clean</b> holders" });
    await review(passed, "decide", "pass", { reasoning: "bundled" });
    // Its trade closed at 3x net (+200%) where the ladder made +50% on the same alert.
    await position(traded, { status: "closed", proceedsSol: 1.5 });

    const res = await call("GET", "/fdsa/record?days=7", "admin");
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.pool).toMatchObject({ total: 6, graded: 5, wins: 2, rate: 0.4 });
    expect(r.screen.shortlisted).toMatchObject({ total: 2, graded: 2, wins: 1 });
    expect(r.screen.dropped).toMatchObject({ total: 3, graded: 3, wins: 1 });
    expect(r.screen.failed).toMatchObject({ total: 1, graded: 0, rate: null });
    expect(r.decide.trade).toMatchObject({ total: 1, graded: 1, wins: 1, rate: 1, wins4x: 1 });
    expect(r.decide.pass).toMatchObject({ total: 1, graded: 1, wins: 0, rate: 0 });
    expect(r.trades).toMatchObject({ total: 1, graded: 1, wins: 1 });
    expect(r.ladder).toMatchObject({
      closedTrades: 1,
      paired: 1,
      fdsaAvgPct: 200,
      ladderAvgPct: 50,
      fdsaBetter: 1,
    });
    expect(r.latency.trades).toBe(1);

    const reviews = await call("GET", "/fdsa/reviews?stage=decide", "admin");
    expect(reviews.statusCode).toBe(200);
    const rows = reviews.json();
    expect(rows.map((x: { decision: string }) => x.decision).sort()).toEqual(["pass", "trade"]);
    expect(rows.find((x: { decision: string }) => x.decision === "trade")).toMatchObject({
      hit2x: true,
      exitPlan: FDSA_DEFAULT_EXIT_PLAN,
    });
    const errors = await call("GET", "/fdsa/reviews?decision=error", "admin");
    expect(errors.json()).toEqual([expect.objectContaining({ stage: "screen", error: "timeout" })]);

    const state = (await call("GET", "/fdsa", "admin")).json();
    expect(state.reviews.today).toMatchObject({ screened: 6, shortlisted: 2, trade: 1, pass: 1, failed: 1 });
    expect(state.reviews.today.shortlistRate).toBeCloseTo(2 / 6);
  });
});
