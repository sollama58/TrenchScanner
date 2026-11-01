// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FDSA_DESK_CONFIG,
  FDSA_DEFAULT_EXIT_PLAN,
  FDSA_DESK_ID,
  loadEnv,
  NoRouteError,
  paperFdsaExecutor,
  PROGRAM,
  prisma,
  runFdsaDesk,
  WSOL_MINT,
  type Env,
  type FdsaDeskDeps,
  type SwapQuote,
} from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

// FDSA's hidden tab API (routes/fdsa.ts; owner decision 2026-10-31): admin wallets only, paper
// only, and a record read honestly off the alerts' own grades.

const ADMIN_WALLET = "FdsaAdmin1111111111111111111111111111111111";
const OTHER_WALLET = "FdsaNotAdmin111111111111111111111111111111";
/** A subscriber (whitelisted), for the readers' #fdsa page (routes/fdsaPublic.ts). */
const READER_WALLET = "FdsaReader11111111111111111111111111111111";
const TAG = "fdsa-route-test";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const userIds: Record<"admin" | "other" | "reader", string> = { admin: "", other: "", reader: "" };

type Method = "GET" | "POST" | "PATCH";
async function call(
  method: Method,
  url: string,
  as: "admin" | "other" | "reader" | "nobody",
  payload?: object,
) {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie =
      as === "nobody"
        ? null
        : await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
            userId: userIds[as],
            walletAddress: as === "admin" ? ADMIN_WALLET : as === "reader" ? READER_WALLET : OTHER_WALLET,
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
    await prisma.user.deleteMany({
      where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET, READER_WALLET] } },
    });
    userIds.admin = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    userIds.other = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
    userIds.reader = (await prisma.user.create({ data: { walletAddress: READER_WALLET } })).id;
    await prisma.whitelist.deleteMany({ where: { walletAddress: READER_WALLET } });
    await prisma.whitelist.create({ data: { walletAddress: READER_WALLET, addedBy: TAG } });
  });
  beforeEach(clear);
  afterAll(async () => {
    if (!dbAvailable) return;
    await clear();
    await prisma.whitelist.deleteMany({ where: { walletAddress: READER_WALLET } });
    await prisma.user.deleteMany({
      where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET, READER_WALLET] } },
    });
  });

  it("answers no one but an admin wallet, and changes nothing for them (decision 7)", async () => {
    const routes: [Method, string, object?][] = [
      ["GET", "/admin/fdsa"],
      ["PATCH", "/admin/fdsa", { running: true }],
      ["POST", "/admin/fdsa/reset", {}],
      ["POST", "/admin/fdsa/positions/x/close", {}],
      ["GET", "/admin/fdsa/positions"],
      ["GET", "/admin/fdsa/record"],
      ["GET", "/admin/fdsa/reviews"],
    ];
    for (const [method, url, body] of routes) {
      expect((await call(method, url, "other", body)).statusCode, `${method} ${url}`).toBe(403);
      expect((await call(method, url, "nobody", body)).statusCode, `${method} ${url}`).toBe(401);
    }
    expect(await prisma.fdsaDesk.count()).toBe(0);
  });

  it("shows readers the desk's record and trades at #fdsa, with no spend, models, reasoning or controls", async () => {
    const won = await alerted("won4x", 30);
    const lost = await alerted("lost", -50);
    const held = await alerted("open");
    for (const a of [won, lost, held]) {
      await review(a, "screen", "shortlist");
      await review(a, "decide", "trade", { reasoning: "SECRET-REASONING" });
    }
    await call("GET", "/admin/fdsa", "admin");
    // The bankroll's trades count from its reset; these were opened before the desk row existed.
    await prisma.fdsaDesk.update({
      where: { id: FDSA_DESK_ID },
      data: { resetAt: new Date(Date.now() - 3_600_000) },
    });
    const w = await position(won, { status: "closed", proceedsSol: 1.2 });
    await prisma.fdsaFill.createMany({
      data: [
        {
          positionId: w.id,
          side: "buy",
          reason: "entry",
          planVersion: 1,
          lamports: 500_000_000n,
          feeLamports: 0n,
          tokens: "1000",
          multiple: 1,
        },
        {
          positionId: w.id,
          side: "sell",
          reason: "partial",
          planVersion: 1,
          lamports: 600_000_000n,
          feeLamports: 0n,
          tokens: "250",
          multiple: 2.4,
        },
        {
          positionId: w.id,
          side: "sell",
          reason: "floor",
          planVersion: 2,
          lamports: 600_000_000n,
          feeLamports: 0n,
          tokens: "750",
          multiple: 1.6,
        },
      ],
    });
    await position(lost, { status: "closed", proceedsSol: 0.25 });
    await position(held, { status: "open" });

    // A subscriber reads it; no access is a 402 and no session a 401, like the curated feed.
    expect((await call("GET", "/fdsa", "other")).statusCode).toBe(402);
    expect((await call("GET", "/fdsa", "nobody")).statusCode).toBe(401);
    expect((await call("GET", "/fdsa?days=5", "reader")).statusCode).toBe(400);
    const res = await call("GET", "/fdsa?days=7", "reader");
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json();
    expect(page.record.trades).toMatchObject({ total: 3, graded: 2, wins: 1 });
    expect(page.funnel).toMatchObject({ screened: 3, shortlisted: 3, decided: 3, bought: 3, won: 1 });
    expect(page.open).toHaveLength(1);
    expect(page.closed).toHaveLength(2);
    expect(page.bankroll.closed).toBe(2);
    // Closed P&L: +0.7 and -0.25 SOL on 0.5 SOL entries.
    expect(page.bankroll.curve.at(-1).pnlSol).toBeCloseTo(0.45, 5);
    expect(page.exits.byReason).toEqual(
      expect.arrayContaining([
        { reason: "partial", count: 1, avgMultiple: 2.4 },
        { reason: "floor", count: 1, avgMultiple: 1.6 },
      ]),
    );
    expect(page.ladder.paired).toBe(2);
    // Nothing admin-only: no spend, model, prompt, reasoning, controls or worker internals.
    const text = res.body;
    for (const banned of [
      "SECRET-REASONING",
      "costUsd",
      "budget",
      "claude-",
      "promptVersion",
      "fdsa-v1",
      "brief",
      "updatedBy",
      "config",
      "lastError",
    ]) {
      expect(text, banned).not.toContain(banned);
    }
    // And it changes nothing: a reader can't reach the controls.
    expect((await call("PATCH", "/fdsa", "reader", { running: true })).statusCode).toBe(404);
    expect((await call("PATCH", "/admin/fdsa", "reader", { running: true })).statusCode).toBe(403);
  });

  it("starts the desk paused, on paper, with the owner's paper defaults", async () => {
    const res = await call("GET", "/admin/fdsa", "admin");
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

  it("reads whether FDSA runs from the scanner's heartbeat, not the API's env", async () => {
    const before = await prisma.systemHeartbeat.findUnique({ where: { job: "scan" } });
    try {
      await prisma.systemHeartbeat.upsert({
        where: { job: "scan" },
        update: { meta: { fdsa: { enabled: true, queued: 2 } } },
        create: { job: "scan", lastRunAt: new Date(), meta: { fdsa: { enabled: true, queued: 2 } } },
      });
      const body = (await call("GET", "/admin/fdsa", "admin")).json();
      expect(body.settings.enabled).toBe(true);
      expect(body.worker.fdsa).toMatchObject({ enabled: true, queued: 2 });
    } finally {
      if (before) {
        await prisma.systemHeartbeat.update({
          where: { job: "scan" },
          data: { meta: before.meta ?? undefined, lastRunAt: before.lastRunAt },
        });
      } else await prisma.systemHeartbeat.deleteMany({ where: { job: "scan" } });
    }
  });

  it("refuses Live, and resumes, pauses and edits the paper limits", async () => {
    const live = await call("PATCH", "/admin/fdsa", "admin", { mode: "live" });
    expect(live.statusCode).toBe(400);
    expect(live.json().error).toMatch(/not available/);
    expect((await call("PATCH", "/admin/fdsa", "admin", { mode: "wild" })).statusCode).toBe(400);

    const before = Date.now();
    const on = await call("PATCH", "/admin/fdsa", "admin", {
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
    const bad = await call("PATCH", "/admin/fdsa", "admin", {
      config: { ...DEFAULT_FDSA_DESK_CONFIG, buySol: -1 },
    });
    expect(bad.statusCode).toBe(400);

    await prisma.fdsaDesk.update({ where: { id: FDSA_DESK_ID }, data: { pausedReason: "daily loss limit" } });
    expect((await call("PATCH", "/admin/fdsa", "admin", { running: false })).statusCode).toBe(200);
    expect(await prisma.fdsaDesk.findUniqueOrThrow({ where: { id: FDSA_DESK_ID } })).toMatchObject({
      running: false,
      pausedReason: null,
    });
  });

  it("resets the paper bankroll only with nothing open, and keeps the history", async () => {
    await call("GET", "/admin/fdsa", "admin");
    const a = await alerted("won", 80);
    const p = await position(a, { status: "open" });
    const refused = await call("POST", "/admin/fdsa/reset", "admin", { bankrollSol: 20 });
    expect(refused.statusCode).toBe(409);

    const closed = await call("POST", `/admin/fdsa/positions/${p.id}/close`, "admin", {});
    expect(closed.statusCode).toBe(200);
    expect((await prisma.fdsaPosition.findUniqueOrThrow({ where: { id: p.id } })).closeRequested).toBe(true);
    await prisma.fdsaPosition.update({
      where: { id: p.id },
      data: { status: "closed", closedAt: new Date() },
    });
    expect((await call("POST", `/admin/fdsa/positions/${p.id}/close`, "admin", {})).statusCode).toBe(404);

    const ok = await call("POST", "/admin/fdsa/reset", "admin", { bankrollSol: 20 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await prisma.fdsaDesk.findUniqueOrThrow({ where: { id: FDSA_DESK_ID } })).toMatchObject({
      bankrollLamports: 20_000_000_000n,
      cashLamports: 20_000_000_000n,
    });
    expect(await prisma.fdsaPosition.count({ where: { id: p.id } })).toBe(1);
  });

  it("shows open positions with their plan, floor and history, and closed ones with P&L", async () => {
    await call("GET", "/admin/fdsa", "admin");
    await position(await alerted("open"), { status: "open", floor: 1 });
    await position(await alerted("won", 40), { status: "closed", proceedsSol: 1 });
    const res = await call("GET", "/admin/fdsa/positions", "admin");
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
    await call("GET", "/admin/fdsa", "admin");
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

    const res = await call("GET", "/admin/fdsa/record?days=7", "admin");
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

    const reviews = await call("GET", "/admin/fdsa/reviews?stage=decide", "admin");
    expect(reviews.statusCode).toBe(200);
    const rows = reviews.json();
    expect(rows.map((x: { decision: string }) => x.decision).sort()).toEqual(["pass", "trade"]);
    expect(rows.find((x: { decision: string }) => x.decision === "trade")).toMatchObject({
      hit2x: true,
      exitPlan: FDSA_DEFAULT_EXIT_PLAN,
    });
    const errors = await call("GET", "/admin/fdsa/reviews?decision=error", "admin");
    expect(errors.json()).toEqual([expect.objectContaining({ stage: "screen", error: "timeout" })]);

    const state = (await call("GET", "/admin/fdsa", "admin")).json();
    expect(state.reviews.today).toMatchObject({ screened: 6, shortlisted: 2, trade: 1, pass: 1, failed: 1 });
    expect(state.reviews.today.shortlistRate).toBeCloseTo(2 / 6);
  });
  it("shows what the paper desk itself books: Resume, a buy, the plan's partial and the floor exit", async () => {
    // Thread E of the FDSA build (2026-11-01): the rows here come from core's runFdsaDesk, the
    // pass the scanner runs, rather than seeded by hand, so the tab is read against what the desk
    // really writes.
    await call("GET", "/admin/fdsa", "admin");
    expect((await call("PATCH", "/admin/fdsa", "admin", { running: true })).statusCode).toBe(200);
    const coin = await alerted("won", 40);
    const verdict = await review(coin, "decide", "trade", { reasoning: "clean holders" });

    // A pretend Jupiter with no price impact: lamports per raw unit, per mint.
    const price = new Map<string, number>([[coin.token.mintAddress, 0.05]]);
    const market: FdsaDeskDeps["market"] = {
      quote: async ({ inputMint, outputMint, amount }) => {
        const mint = inputMint === WSOL_MINT ? outputMint : inputMint;
        const p = price.get(mint);
        if (p === undefined) throw new NoRouteError("no route");
        const out = inputMint === WSOL_MINT ? Number(amount) / p : Number(amount) * p;
        return {
          inputMint,
          outputMint,
          inAmount: amount.toString(),
          outAmount: BigInt(Math.floor(out)).toString(),
          otherAmountThreshold: "0",
          priceImpactPct: "0",
        } as SwapQuote;
      },
      pricesUsd: async (mints) =>
        new Map(
          mints.flatMap((m): [string, number][] =>
            m === WSOL_MINT ? [[m, 200]] : price.has(m) ? [[m, ((price.get(m)! * 1e6) / 1e9) * 200]] : [],
          ),
        ),
    };
    const rpc = {
      getMintInfo: async () => ({
        program: PROGRAM.token,
        mintAuthority: null,
        freezeAuthority: null,
        extensions: [],
        decimals: 6,
      }),
    };
    const pass = () =>
      runFdsaDesk({
        market,
        rpc,
        executor: paperFdsaExecutor({ swap: market, rpc }),
        entries: true,
        revision: { timerMinutes: 10, drawdownPct: 30, minGapSeconds: 0 },
      });
    expect(await pass()).toMatchObject({ running: true, entries: 1 });
    // 3x on the entry (the 1% fill penalty puts the entry at 1/0.99 of the quote): the default
    // plan's quarter goes, then 1.5x is under its trailed floor (3 x 0.6) and the rest goes.
    price.set(coin.token.mintAddress, (0.05 * 3) / 0.99);
    expect(await pass()).toMatchObject({ sells: 1 });
    price.set(coin.token.mintAddress, (0.05 * 1.5) / 0.99);
    expect(await pass()).toMatchObject({ sells: 1, open: 0 });

    const { open, closed } = (await call("GET", "/admin/fdsa/positions", "admin")).json();
    expect(open).toEqual([]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      closeReason: "floor",
      hit2x: true,
      ladderReturnPct: 40,
      planVersion: 1,
    });
    expect(closed[0].pnlPct).toBeGreaterThan(0);
    expect(closed[0].revisions).toEqual([
      expect.objectContaining({ trigger: "entry", status: "applied", reason: "clean holders" }),
    ]);

    const state = (await call("GET", "/admin/fdsa", "admin")).json();
    expect(state.desk).toMatchObject({ running: true, openPositions: 0 });
    expect(state.desk.stats).toMatchObject({ entries: 1, closed: 1 });
    expect(BigInt(state.desk.cashLamports)).toBeGreaterThan(10_000_000_000n);

    const record = (await call("GET", "/admin/fdsa/record?days=7", "admin")).json();
    expect(record.trades).toMatchObject({ total: 1, graded: 1, wins: 1 });
    expect(record.ladder).toMatchObject({ closedTrades: 1, paired: 1, ladderAvgPct: 40 });
    expect(record.latency.trades).toBe(1);
    const reviews = (await call("GET", "/admin/fdsa/reviews?stage=decide", "admin")).json();
    expect(reviews).toEqual([expect.objectContaining({ id: verdict.id, decision: "trade", hit2x: true })]);
  });
});
