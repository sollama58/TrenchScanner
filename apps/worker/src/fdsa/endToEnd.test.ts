// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  prisma,
  loadEnv,
  readFdsaBudget,
  readAiBudget,
  DEFAULT_FDSA_DESK_CONFIG,
  FDSA_DESK_ID,
  FDSA_HARD_FLOOR_MULTIPLE,
  HIGH_CONVICTION_TIER,
  NoRouteError,
  WSOL_MINT,
  PROGRAM,
  type CurationDecision,
  type Env,
  type FdsaExitPlan,
  type JupiterSwapClient,
  type MintInfo,
  type ScoredToken,
  type SwapQuote,
  type TradingRpc,
} from "@trenchscanner/core";

/**
 * FDSA end to end across its four pieces (Thread E of the FDSA build, 2026-11-01): a curated
 * alert goes through the review pipeline (fdsa/review.ts, mocked Anthropic), the trade verdict is
 * bought by the paper desk the scanner's job runs (jobs/fdsaDeskJob.ts on core's runFdsaDesk, a
 * pretend Jupiter), the plan is revised at 2x through the review pipeline's own revise stage, an
 * Anthropic outage at the next trigger leaves the plan running, and the position exits on its
 * raised floor in profit. Every row the #fdsa tab reads (apps/api/src/routes/fdsa.ts) is checked
 * for the links it joins on: review to position, position to outcome, revision to review.
 */

type Reply = Record<string, unknown> | Error;
const replies: Reply[] = [];
const requests: Record<string, unknown>[] = [];
const create = vi.fn(async (body: Record<string, unknown>) => {
  requests.push(body);
  const next = replies.shift();
  if (!next) throw new Error("no reply queued");
  if (next instanceof Error) throw next;
  return next;
});
vi.mock("../ai/client.js", async (importActual) => ({
  ...(await importActual<typeof import("../ai/client.js")>()),
  anthropicClient: () => ({ beta: { messages: { create } } }),
}));
const { enqueueFdsaAlert, drainFdsaReviews, fdsaHeartbeat, resetFdsaReviews } = await import("./review.js");
const { createFdsaDeskRunner } = await import("../jobs/fdsaDeskJob.js");
const { createPaperTradingRunner } = await import("../jobs/paperTradingJob.js");
const { resetAiBudget } = await import("../ai/budget.js");
const { resetComparablePoolCache } = await import("../ai/reviewer.js");

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
// A day of its own, so the ledger rows here never mix with a real day's (as review.test.ts).
const DAY = "2001-05-06";
const TAG = `FdsaE2E${Date.now().toString(36)}`;
const SOL = 1_000_000_000n;
const ENTRY_PRICE = 0.05; // lamports per raw unit
/** The 1% fill penalty puts the entry at 1/0.99 of the quote, so this price reads as `multiple`. */
const priceFor = (multiple: number) => (ENTRY_PRICE * multiple) / 0.99;

/** A pretend Jupiter with no price impact (as core's paperDesk.test.ts). */
class FakeMarket {
  lamportsPerRaw = new Map<string, number>();
  solUsd = 200;
  quote = async ({
    inputMint,
    outputMint,
    amount,
  }: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
  }): Promise<SwapQuote> => {
    const mint = inputMint === WSOL_MINT ? outputMint : inputMint;
    const p = this.lamportsPerRaw.get(mint);
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
  };
  pricesUsd = async (mints: string[]) => {
    const out = new Map<string, number>();
    for (const mint of mints) {
      if (mint === WSOL_MINT) out.set(mint, this.solUsd);
      const p = this.lamportsPerRaw.get(mint);
      if (p !== undefined) out.set(mint, ((p * 1e6) / 1e9) * this.solUsd);
    }
    return out;
  };
  getMintInfo = async (): Promise<MintInfo> => ({
    program: PROGRAM.token,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: [],
    decimals: 6,
  });
}

const usage = {
  input_tokens: 1_000,
  output_tokens: 200,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const reply = (model: string, answer: unknown) => ({
  model,
  stop_reason: "end_turn",
  content: [
    { type: "thinking", thinking: "" },
    { type: "text", text: JSON.stringify(answer) },
  ],
  usage,
});

const ENTRY_PLAN: FdsaExitPlan = {
  // Under the -50% stop: the decide stage's reader clamps it back up (decision 8).
  stopMultiple: 0.2,
  lockIns: [],
  trail: [{ fromMultiple: 2, fraction: 0.5 }],
  partials: [{ atMultiple: 2, sellFraction: 0.25 }],
  maxHoldMinutes: 180,
  stall: null,
};

const decision = {
  curate: true,
  confidence: 80,
  reasons: ["momentum"],
  source: "heuristic-v1",
  tier: HIGH_CONVICTION_TIER,
} as CurationDecision;

describe.skipIf(!dbAvailable)("FDSA end to end: alert to exit", () => {
  const base = dbAvailable ? loadEnv() : (undefined as never);
  const env: Env = dbAvailable
    ? {
        ...base,
        ANTHROPIC_API_KEY: "test-key",
        FDSA_ENABLED: true,
        // The Haiku screen: what this test mocks (the model-score screen is tested in review.test.ts).
        FDSA_SCREEN_SOURCE: "haiku",
        FDSA_SCREEN_MIN_SCORE: 0.7,
        FDSA_DAILY_BUDGET_USD: 5,
        FDSA_EXIT_RESERVE_PCT: 25,
        FDSA_REVISION_TIMER_MINUTES: 10,
        FDSA_REVISION_MIN_GAP_SECONDS: 120,
        TELEGRAM_BOT_TOKEN: "",
      }
    : base;
  let clock: Date;
  const later = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
    vi.setSystemTime(clock);
  };
  let market: FakeMarket;
  let pending: Promise<void>[];
  const tokenIds: string[] = [];

  /** One run of the scanner's FDSA desk job, then every revision call it set off. */
  const runDesk = async () => {
    const run = createFdsaDeskRunner(env, {
      swap: market as unknown as JupiterSwapClient,
      rpc: market as unknown as TradingRpc,
      telegram: null,
      admins: new Set(),
      dispatch: (p) => void pending.push(p),
    });
    const meta = await run();
    await Promise.all(pending.splice(0));
    return meta;
  };
  const position = (mint: string) =>
    prisma.fdsaPosition.findUniqueOrThrow({
      where: { deskId_mint: { deskId: FDSA_DESK_ID, mint } },
      include: { fills: { orderBy: { createdAt: "asc" } }, revisions: { orderBy: { createdAt: "asc" } } },
    });

  beforeAll(async () => {
    if (!dbAvailable) return;
    await prisma.fdsaPosition.updateMany({ where: { status: "open" }, data: { status: "closed" } });
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock = new Date(`${DAY}T12:00:00Z`);
    vi.setSystemTime(clock);
    replies.length = 0;
    requests.length = 0;
    create.mockClear();
    pending = [];
    market = new FakeMarket();
    resetFdsaReviews();
    resetAiBudget();
    resetComparablePoolCache();
    await prisma.aiSpend.deleteMany({ where: { day: DAY } });
    // The desk as the tab's Resume leaves it: running, on paper, reading alerts from now.
    const desk = {
      mode: "paper",
      running: true,
      pausedReason: null,
      config: DEFAULT_FDSA_DESK_CONFIG,
      bankrollLamports: 10n * SOL,
      cashLamports: 10n * SOL,
      resetAt: clock,
      signalsFrom: clock,
      lossWindowFrom: clock,
    };
    await prisma.fdsaDesk.upsert({
      where: { id: FDSA_DESK_ID },
      create: { id: FDSA_DESK_ID, ...desk },
      update: desk,
    });
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.aiSpend.deleteMany({ where: { day: DAY } });
    await prisma.fdsaDesk.updateMany({ where: { id: FDSA_DESK_ID }, data: { running: false } });
    await prisma.fdsaPosition.deleteMany({ where: { tokenId: { in: tokenIds } } });
    await prisma.token.deleteMany({ where: { id: { in: tokenIds } } });
  });

  async function alertFor(symbol: string) {
    const mint = `${TAG}${symbol}`.padEnd(43, "1");
    const token = await prisma.token.create({ data: { mintAddress: mint, symbol, name: symbol } });
    tokenIds.push(token.id);
    const outcome = await prisma.candidateOutcome.create({
      data: {
        tokenId: token.id,
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 85_000,
        features: {},
        nextCheckAt: new Date(),
        peak1hPriceUsd: 0.0001,
        low1hPriceUsd: 0.0001,
        lowBefore2xPriceUsd: 0.0001,
        peak24hPriceUsd: 0.0001,
        sampleKind: "event",
      },
    });
    market.lamportsPerRaw.set(mint, ENTRY_PRICE);
    const scored = {
      mintAddress: mint,
      symbol,
      name: symbol,
      description: "a dog coin",
      priceUsd: 0.0001,
      marketCapUsd: 85_000,
      narrativeTags: [],
      ageMinutes: 42,
      graduated: false,
      score: { total: 71, momentum: 80, holderHealth: 60, age: 70, narrative: 50 },
    } as unknown as ScoredToken;
    return {
      tokenId: token.id,
      mint,
      scored,
      decision,
      candidateOutcomeId: outcome.id,
      curatedAlertId: null,
      alertAt: new Date(),
    };
  }

  it("screens, decides, paper-buys, revises at 2x, survives an outage and exits on the raised floor", async () => {
    const alert = await alertFor("RUN");

    // 1. Emission hands the alert over detached; the screen shortlists it and the decide trades.
    replies.push(
      reply("claude-haiku-5-5", { score: 0.86, reason: "strong flow" }),
      reply("claude-opus-5-5", {
        decision: "trade",
        probability2x: 0.55,
        probability4x: 0.2,
        conviction: 0.7,
        exitPlan: ENTRY_PLAN,
        reasoning: "Clean holders and accelerating buys.",
        risks: ["young pool"],
      }),
    );
    enqueueFdsaAlert(alert, env);
    enqueueFdsaAlert(alert, env); // the same token from another seat: one review
    expect(await drainFdsaReviews(10_000)).toBe(0);
    expect(create).toHaveBeenCalledTimes(2);
    const decide = await prisma.fdsaReview.findFirstOrThrow({
      where: { tokenId: alert.tokenId, stage: "decide" },
    });
    expect(decide).toMatchObject({ decision: "trade", candidateOutcomeId: alert.candidateOutcomeId });
    expect((decide.exitPlan as FdsaExitPlan).stopMultiple).toBe(FDSA_HARD_FLOOR_MULTIPLE);

    // 2. Twenty seconds later the scanner's desk job buys it at the fixed 0.5 SOL, on paper.
    later(20 / 60);
    let meta = await runDesk();
    expect(meta).toMatchObject({ fdsaRunning: true, fdsaEntries: 1, fdsaOpen: 1, fdsaErrors: 0 });
    let p = await position(alert.mint);
    expect(p).toMatchObject({
      status: "open",
      mode: "paper",
      sourceKind: "fdsa",
      reviewId: decide.id,
      tokenId: alert.tokenId,
      candidateOutcomeId: alert.candidateOutcomeId,
      swapInLamports: SOL / 2n,
      planVersion: 1,
      floorMultiple: FDSA_HARD_FLOOR_MULTIPLE,
    });
    expect(p.signalAt).toEqual(alert.alertAt);
    expect(p.revisions).toMatchObject([{ trigger: "entry", status: "applied", reviewId: decide.id }]);
    // Bought once: the same verdict on the next pass is left alone.
    expect((await runDesk()).fdsaEntries).toBe(0);

    // 3. 2.2x: the plan's own partial (no preset ladder), and the trail raises the floor.
    market.lamportsPerRaw.set(alert.mint, priceFor(2.2));
    later(1);
    meta = await runDesk();
    expect(meta.fdsaSells).toBe(1);
    p = await position(alert.mint);
    expect(p.fills.at(-1)).toMatchObject({ side: "sell", reason: "partial", planVersion: 1 });
    expect(p.floorMultiple).toBeCloseTo(1.1, 2);

    // 4. Held at 2.2x: crossing 2x asks the review pipeline's revise stage. The model tightens
    //    the trail, and sends a stop under the floor, which applies raised to the floor.
    replies.push(
      reply("claude-opus-5-5", {
        action: "revise",
        exitPlan: { ...ENTRY_PLAN, stopMultiple: 0.5, trail: [{ fromMultiple: 2, fraction: 0.2 }] },
        reason: "Runner; tighten the trail.",
      }),
    );
    later(1);
    meta = await runDesk();
    expect(meta.fdsaRevisions).toBe(1);
    p = await position(alert.mint);
    expect(p.planVersion).toBe(2);
    expect((p.exitPlan as FdsaExitPlan).stopMultiple).toBeGreaterThanOrEqual(1.1 - 1e-9);
    expect(p.floorMultiple).toBeCloseTo(2.2 * 0.8, 2);
    const applied = p.revisions.at(-1)!;
    expect(applied).toMatchObject({ trigger: "crossed_2x", status: "applied", version: 2 });
    // The revision links to the stored revise review, which links back to the position and the
    // alert's outcome, so the tab can show it and the record can grade it.
    const revise = await prisma.fdsaReview.findUniqueOrThrow({ where: { id: applied.reviewId! } });
    expect(revise).toMatchObject({
      stage: "revise",
      decision: "revise",
      positionId: p.id,
      candidateOutcomeId: alert.candidateOutcomeId,
      alertAt: alert.alertAt,
    });

    // 5. Ten minutes on, the timer asks again and Anthropic is down: recorded as failed, the
    //    plan stays, and the same pass still priced the position.
    replies.push(new Anthropic.APIConnectionError({ message: "down" }));
    later(10);
    meta = await runDesk();
    expect(meta).toMatchObject({ fdsaRevisions: 1, fdsaExitsChecked: 1 });
    p = await position(alert.mint);
    expect(p.planVersion).toBe(2);
    expect(p.revisions.at(-1)).toMatchObject({ trigger: "timer", status: "rejected", version: 2 });
    expect(p.lastPricedAt).toEqual(clock);

    // 6. Down to 1.7x, under the revised floor (1.76): the rest goes, in profit.
    market.lamportsPerRaw.set(alert.mint, priceFor(1.7));
    later(1);
    meta = await runDesk();
    expect(meta.fdsaSells).toBe(1);
    p = await position(alert.mint);
    expect(p).toMatchObject({ status: "closed", closeReason: "floor", tokensHeld: "0" });
    expect(p.fills.at(-1)).toMatchObject({ side: "sell", reason: "floor", planVersion: 2 });
    expect(p.proceedsLamports).toBeGreaterThan(p.swapInLamports + p.feesLamports);
    const desk = await prisma.fdsaDesk.findUniqueOrThrow({ where: { id: FDSA_DESK_ID } });
    expect(desk.cashLamports).toBe(10n * SOL - SOL / 2n - p.feesLamports + p.proceedsLamports);

    // Spend: all four calls on FDSA's own ledger, the revisions under its exit share, and none on
    // the reviewer's cap (decisions 2 and 5).
    const budget = await readFdsaBudget(env);
    expect(Object.fromEntries(budget.bySource.map((s) => [s.source, s.calls]))).toEqual({
      "fdsa-decide": 1,
      "fdsa-exit": 2,
      "fdsa-screen": 1,
    });
    expect((await readAiBudget(env)).spentUsd).toBe(0);
    expect(await fdsaHeartbeat(env)).toMatchObject({
      enabled: true,
      running: true,
      screened: 1,
      shortlisted: 1,
      trades: 1,
      staleTrades: 0,
    });
  });

  it("with FDSA switched off, nothing is reviewed or bought, but an open position still exits", async () => {
    const alert = await alertFor("OFF");
    const off: Env = { ...env, FDSA_ENABLED: false };
    enqueueFdsaAlert(alert, off);
    expect(await drainFdsaReviews(1_000)).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(await prisma.fdsaReview.count({ where: { tokenId: alert.tokenId } })).toBe(0);

    // A position opened while it was on, now under its -50% stop.
    await prisma.fdsaPosition.create({
      data: {
        deskId: FDSA_DESK_ID,
        mint: alert.mint,
        tokenId: alert.tokenId,
        signalAt: clock,
        openedAt: clock,
        status: "open",
        swapInLamports: SOL / 2n,
        tokensBought: "10000000000",
        tokensHeld: "10000000000",
        decimals: 6,
        exitPlan: { ...ENTRY_PLAN, stopMultiple: FDSA_HARD_FLOOR_MULTIPLE },
        floorMultiple: FDSA_HARD_FLOOR_MULTIPLE,
      },
    });
    market.lamportsPerRaw.set(alert.mint, priceFor(0.4));
    later(1);
    const run = createFdsaDeskRunner(off, {
      swap: market as unknown as JupiterSwapClient,
      rpc: market as unknown as TradingRpc,
      telegram: null,
      admins: new Set(),
    });
    expect(await run()).toMatchObject({ fdsaEntries: 0, fdsaSells: 1 });
    expect(await position(alert.mint)).toMatchObject({ status: "closed", closeReason: "stop_loss" });
  });

  it("the paper-trading job runs FDSA's pass even when the strategies' pass throws", async () => {
    const runner = createPaperTradingRunner(env);
    // The strategies' pass reads its open positions first; a dead pool there must not skip the
    // FDSA pass behind it, whose first read (FDSA on) is the desk row.
    const strategies = vi
      .spyOn(prisma.paperPosition, "findMany")
      .mockRejectedValueOnce(new Error("pool timeout"));
    const fdsaDesk = vi.spyOn(prisma.fdsaDesk, "upsert");
    try {
      await expect(runner()).rejects.toThrow("pool timeout");
      expect(fdsaDesk).toHaveBeenCalled();
    } finally {
      strategies.mockRestore();
      fdsaDesk.mockRestore();
    }
  });
});
