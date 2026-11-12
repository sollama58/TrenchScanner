import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import { NoRouteError, WSOL_MINT, type SwapQuote } from "../trading/jupiterSwap.js";
import type { MintInfo } from "../trading/rpc.js";
import { PROGRAM } from "../trading/txGuard.js";
import type { TradeNote } from "../trading/tradeNotes.js";
import { DEFAULT_FDSA_DESK_CONFIG, FDSA_DESK_ID } from "./desk.js";
import { FDSA_HARD_FLOOR_MULTIPLE, type FdsaExitPlan } from "./exitPlan.js";
import {
  paperFdsaExecutor,
  runFdsaDesk,
  type FdsaDeskDeps,
  type FdsaReviser,
  type FdsaRevisionRequest,
  type FdsaRevisionResult,
} from "./paperDesk.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const SOL = 1_000_000_000n;
const ENTRY_PRICE = 0.05; // lamports per raw unit
/** The 1% fill penalty puts the entry at 1/0.99 of the quote, so this price reads as `multiple`. */
const priceFor = (multiple: number) => (ENTRY_PRICE * multiple) / 0.99;

/** A pretend Jupiter with no price impact, as paper.test.ts's. */
class FakeMarket {
  lamportsPerRaw = new Map<string, number>();
  solUsd = 200;
  noRoute = new Set<string>();
  mintInfo: (mint: string) => MintInfo | null = () => ({
    program: PROGRAM.token,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: [],
    decimals: 6,
  });
  swap: FdsaDeskDeps["market"] = {
    quote: async ({ inputMint, outputMint, amount }) => {
      const mint = inputMint === WSOL_MINT ? outputMint : inputMint;
      const p = this.lamportsPerRaw.get(mint);
      if (p === undefined || this.noRoute.has(mint)) throw new NoRouteError("no route");
      const out = inputMint === WSOL_MINT ? Number(amount) / p : Number(amount) * p;
      return {
        inputMint,
        outputMint,
        inAmount: amount.toString(),
        outAmount: BigInt(Math.floor(out)).toString(),
        otherAmountThreshold: "0",
        priceImpactPct: "0",
      } satisfies SwapQuote;
    },
    pricesUsd: async (mints) => {
      const out = new Map<string, number>();
      for (const mint of mints) {
        if (mint === WSOL_MINT) out.set(mint, this.solUsd);
        const p = this.lamportsPerRaw.get(mint);
        if (p !== undefined) out.set(mint, ((p * 1e6) / 1e9) * this.solUsd);
      }
      return out;
    },
  };
  rpc = { getMintInfo: async (mint: string) => this.mintInfo(mint) };
}

/** A revise stage that answers what each test tells it to. */
class FakeReviser implements FdsaReviser {
  requests: FdsaRevisionRequest[] = [];
  answer: (r: FdsaRevisionRequest) => Promise<FdsaRevisionResult> = async () => ({
    ok: true,
    reviewId: null,
    read: { verdict: { action: "keep", proposed: null, reason: "fine" }, error: null, refused: false },
  });
  revise(r: FdsaRevisionRequest) {
    this.requests.push(r);
    return this.answer(r);
  }
}

const ENTRY_PLAN: FdsaExitPlan = {
  stopMultiple: FDSA_HARD_FLOOR_MULTIPLE,
  lockIns: [],
  trail: [{ fromMultiple: 2, fraction: 0.5 }],
  partials: [{ atMultiple: 2, sellFraction: 0.25 }],
  maxHoldMinutes: 180,
  stall: null,
};

describe.skipIf(!dbAvailable)("FDSA paper desk", () => {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const tokenIds: string[] = [];
  const mints: string[] = [];
  let market: FakeMarket;
  let reviser: FakeReviser;
  let notes: TradeNote[];
  let pending: Promise<void>[];
  let clock: Date;

  const deps = (over: Partial<FdsaDeskDeps> = {}): FdsaDeskDeps => ({
    market: market.swap,
    rpc: market.rpc,
    executor: paperFdsaExecutor({ swap: market.swap, rpc: market.rpc }),
    entries: true,
    reviser,
    revision: { timerMinutes: 10, drawdownPct: 30, minGapSeconds: 0 },
    now: () => clock,
    notify: async (n) => void notes.push(...n),
    dispatch: (p) => void pending.push(p),
    ...over,
  });
  /** One desk pass, then every revision it set off. */
  const pass = async (over: Partial<FdsaDeskDeps> = {}) => {
    const s = await runFdsaDesk(deps(over));
    await Promise.all(pending.splice(0));
    return s;
  };

  async function token(symbol: string) {
    const mint = `Fdsa${run}${symbol}`.padEnd(43, "1");
    const t = await prisma.token.create({ data: { mintAddress: mint, symbol } });
    tokenIds.push(t.id);
    mints.push(mint);
    market.lamportsPerRaw.set(mint, ENTRY_PRICE);
    return { tokenId: t.id, mint };
  }

  async function tradeVerdict(tokenId: string, ageSeconds = 20, plan: object = ENTRY_PLAN) {
    return prisma.fdsaReview.create({
      data: {
        tokenId,
        stage: "decide",
        dedupeKey: `${tokenId}:decide`,
        model: "claude-opus-5-5",
        effort: "medium",
        promptVersion: "fdsa-v1",
        decision: "trade",
        probability2x: 0.4,
        probability4x: 0.15,
        conviction: 0.7,
        exitPlan: plan,
        reasoning: "test",
        latencyMs: 12_000,
        alertAt: new Date(clock.getTime() - ageSeconds * 1000),
        anchorPriceUsd: 0.00001,
        anchorMcapUsd: 10_000,
      },
    });
  }

  async function resetDesk(config: object = {}, running = true) {
    const desk = {
      mode: "paper",
      running,
      pausedReason: null,
      config: { ...DEFAULT_FDSA_DESK_CONFIG, ...config },
      bankrollLamports: 10n * SOL,
      cashLamports: 10n * SOL,
      resetAt: clock,
      signalsFrom: new Date(clock.getTime() - 5 * 60_000),
      lossWindowFrom: new Date(clock.getTime() - 5 * 60_000),
    };
    await prisma.fdsaDesk.upsert({
      where: { id: FDSA_DESK_ID },
      create: { id: FDSA_DESK_ID, ...desk },
      update: desk,
    });
  }

  const position = (mint: string) =>
    prisma.fdsaPosition.findUniqueOrThrow({
      where: { deskId_mint: { deskId: FDSA_DESK_ID, mint } },
      include: { fills: { orderBy: { createdAt: "asc" } }, revisions: { orderBy: { createdAt: "asc" } } },
    });
  const cash = async () =>
    (await prisma.fdsaDesk.findUniqueOrThrow({ where: { id: FDSA_DESK_ID } })).cashLamports;
  const later = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };

  beforeEach(async () => {
    market = new FakeMarket();
    reviser = new FakeReviser();
    notes = [];
    pending = [];
    clock = new Date();
    await prisma.fdsaPosition.deleteMany({ where: { mint: { in: mints } } });
    await prisma.fdsaReview.deleteMany({ where: { tokenId: { in: tokenIds } } });
    // Positions other suites left open (they share the one desk) are taken out of this pass's way.
    await prisma.fdsaPosition.updateMany({ where: { status: "open" }, data: { status: "closed" } });
    await resetDesk();
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.fdsaDesk.updateMany({ where: { id: FDSA_DESK_ID }, data: { running: false } });
    await prisma.fdsaPosition.deleteMany({ where: { mint: { in: mints } } });
    await prisma.token.deleteMany({ where: { id: { in: tokenIds } } });
  });

  it("alert to exit: buys a trade verdict, takes its partial, revises at 2x, and exits on the raised floor", async () => {
    const { tokenId, mint } = await token("RUN");
    const review = await tradeVerdict(tokenId);

    // Entry: 0.5 SOL at the quote less 1%, the fee on top, the entry plan recorded.
    let s = await pass();
    expect(s).toMatchObject({ running: true, entries: 1, open: 1 });
    let p = await position(mint);
    expect(p).toMatchObject({
      status: "open",
      sourceKind: "fdsa",
      mode: "paper",
      reviewId: review.id,
      planVersion: 1,
      swapInLamports: SOL / 2n,
      floorMultiple: 0.5,
    });
    expect(p.verdictAt).toEqual(review.createdAt);
    expect(p.fills).toHaveLength(1);
    expect(p.revisions).toMatchObject([
      { trigger: "entry", status: "applied", version: 1, reviewId: review.id },
    ]);
    const fee = p.feesLamports;
    expect(await cash()).toBe(10n * SOL - SOL / 2n - fee);
    expect(notes.map((n) => n.html).join("\n")).toMatch(/FDSA · Paper.*bought/);

    // Bought once: the next pass sees the same verdict and leaves it.
    s = await pass();
    expect(s.entries).toBe(0);

    // 2.2x: the plan's quarter is sold.
    market.lamportsPerRaw.set(mint, priceFor(2.2));
    later(1);
    s = await pass();
    expect(s.sells).toBe(1);
    p = await position(mint);
    expect(p.soldFraction).toBeCloseTo(0.25, 3);
    expect(p.partialsTaken).toBe(1);
    expect(p.fills.at(-1)).toMatchObject({ side: "sell", reason: "partial", planVersion: 1 });
    expect(p.floorMultiple).toBeCloseTo(1.1, 2); // trail: 2.2 x 0.5

    // Same price, held: crossing 2x asks for a revision. The model sends a plan with the -50%
    // stop and a tight trail; it applies with its stop raised to the floor (never loosened).
    reviser.answer = async () => ({
      ok: true,
      reviewId: null,
      read: {
        verdict: {
          action: "revise",
          proposed: { ...ENTRY_PLAN, stopMultiple: 0.5, trail: [{ fromMultiple: 2, fraction: 0.2 }] },
          reason: "runner, tighten",
        },
        error: null,
        refused: false,
      },
    });
    later(1);
    s = await pass();
    expect(s.revisionsDispatched).toBe(1);
    expect(reviser.requests[0]).toMatchObject({ trigger: "crossed_2x", planVersion: 1 });
    // The request carries the desk's own tape (one reading per priced tick, oldest first) and the
    // fill's price in USD at the market's SOL price, for the revise brief.
    const req = reviser.requests[0]!;
    // The first tick priced the fill at the quote, so it reads the 1% penalty: 0.99.
    expect(req.tape.map((t) => Number(t.multiple.toFixed(2)))).toEqual([0.99, 2.2, 2.2]);
    expect(req.tape[0]!.minutesAgo).toBeCloseTo(2, 5);
    expect(req.tape.at(-1)!.minutesAgo).toBe(0);
    // Entry: 0.5 SOL less the 1% fill penalty for tokens at ENTRY_PRICE lamports a raw unit.
    expect(req.entryPriceUsd).toBeCloseTo(((ENTRY_PRICE / 0.99) * 1e6 * market.solUsd) / 1e9, 6);
    p = await position(mint);
    expect(p.planVersion).toBe(2);
    expect(p.triggersFired).toContain("crossed_2x");
    const plan = p.exitPlan as FdsaExitPlan;
    expect(plan.stopMultiple).toBeGreaterThanOrEqual(1.1 - 1e-9);
    // Held to the exit floor: its 20% trail from 1.2x joins the model's own tier.
    expect(plan.trail).toEqual([
      { fromMultiple: 1.2, fraction: 0.2 },
      { fromMultiple: 2, fraction: 0.2 },
    ]);
    expect(p.floorMultiple).toBeCloseTo(2.2 * 0.8, 2);
    expect(p.revisions.at(-1)).toMatchObject({ trigger: "crossed_2x", status: "applied", version: 2 });

    // Down to 1.7x: under the revised floor (1.76), so the rest goes, in profit.
    market.lamportsPerRaw.set(mint, priceFor(1.7));
    later(1);
    s = await pass();
    expect(s.sells).toBe(1);
    p = await position(mint);
    expect(p).toMatchObject({ status: "closed", closeReason: "floor", tokensHeld: "0" });
    expect(p.fills.at(-1)).toMatchObject({ side: "sell", reason: "floor", planVersion: 2 });
    expect(p.proceedsLamports).toBeGreaterThan(p.swapInLamports + p.feesLamports);
    expect(await cash()).toBe(10n * SOL - SOL / 2n - fee + p.proceedsLamports);
    expect(notes.map((n) => n.html).join("\n")).toMatch(/profit floor.*closed \+/);
  });

  it("an Anthropic outage never stops an exit: a failed call is recorded, a hung one never waited on", async () => {
    const { tokenId, mint } = await token("OUT");
    await tradeVerdict(tokenId);
    await pass();

    // Ten minutes on: the timer asks, and the call fails.
    reviser.answer = async () => {
      throw new Error("529 overloaded");
    };
    later(11);
    await pass();
    let p = await position(mint);
    expect(p.status).toBe("open");
    expect(p.planVersion).toBe(1);
    expect(p.revisions.at(-1)).toMatchObject({ trigger: "timer", status: "failed", error: "529 overloaded" });

    // Next timer: the call hangs. The pass doesn't wait for it.
    reviser.answer = () => new Promise<FdsaRevisionResult>(() => undefined);
    later(11);
    const s = await runFdsaDesk(deps({ dispatch: () => undefined }));
    expect(s.revisionsDispatched).toBe(1);

    // The -50% stop still sells on the last good plan.
    market.lamportsPerRaw.set(mint, priceFor(0.45));
    later(1);
    await pass({ reviser: undefined });
    p = await position(mint);
    expect(p).toMatchObject({ status: "closed", closeReason: "stop_loss" });
  });

  it("a refused or invalid revision keeps the running plan, and a late one is dropped", async () => {
    const { tokenId, mint } = await token("KEEP");
    await tradeVerdict(tokenId);
    await pass();
    reviser.answer = async () => ({
      ok: true,
      reviewId: null,
      read: { verdict: { action: "keep", proposed: null, reason: "" }, error: "refused", refused: true },
    });
    later(11);
    await pass();
    let p = await position(mint);
    expect(p.planVersion).toBe(1);
    expect(p.revisions.at(-1)).toMatchObject({ status: "rejected", error: "refused" });

    // A revision that lands after the position closed changes nothing.
    let release: () => void = () => undefined;
    reviser.answer = (r) =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            ok: true,
            reviewId: null,
            read: {
              verdict: { action: "revise", proposed: r.plan, reason: "late" },
              error: null,
              refused: false,
            },
          });
      });
    later(11);
    await runFdsaDesk(deps());
    const inFlight = pending.splice(0);
    market.lamportsPerRaw.set(mint, priceFor(0.4));
    later(1);
    await runFdsaDesk(deps({ reviser: undefined }));
    release();
    await Promise.all(inFlight);
    p = await position(mint);
    expect(p).toMatchObject({ status: "closed", planVersion: 1 });
    expect(p.revisions.at(-1)).toMatchObject({ status: "failed" });
    expect(p.revisions.at(-1)!.error).toMatch(/late/);
  });

  it("buys only fresh verdicts, once per mint, under the open-position cap and the reserve", async () => {
    const fresh = await token("FRESH");
    const stale = await token("STALE");
    const risky = await token("RISKY");
    await tradeVerdict(fresh.tokenId, 20);
    await tradeVerdict(stale.tokenId, 600);
    await tradeVerdict(risky.tokenId, 10);
    market.mintInfo = (m) => ({
      program: PROGRAM.token,
      mintAuthority: m === risky.mint ? "SomeAuthority111111111111111111111111111111" : null,
      freezeAuthority: null,
      extensions: [],
      decimals: 6,
    });
    const s = await pass();
    expect(s.entries).toBe(1);
    expect(s.skips.map((k) => k.why)).toEqual(["mint authority not revoked"]);
    expect((await position(fresh.mint)).status).toBe("open");
    expect(await prisma.fdsaPosition.count({ where: { mint: { in: [stale.mint, risky.mint] } } })).toBe(0);

    // At the cap: the next verdict waits (and is bought once room opens while it is fresh).
    const second = await token("SECOND");
    await tradeVerdict(second.tokenId, 5);
    await resetDesk({ maxOpenPositions: 1 });
    await prisma.fdsaPosition.updateMany({ where: { mint: fresh.mint }, data: { status: "open" } });
    const capped = await pass();
    expect(capped.skips.map((k) => k.why)).toContain("at the open-position limit");

    // Not enough paper SOL above the reserve.
    await resetDesk({ maxOpenPositions: 6, reserveSol: 9.9 });
    const poor = await pass();
    expect(poor.skips.map((k) => k.why)).toContain("not enough paper SOL above the reserve");
  });

  it("buys nothing while paused or with FDSA off, but exits still run", async () => {
    const { tokenId, mint } = await token("PAUSE");
    await tradeVerdict(tokenId);
    await resetDesk({}, false);
    expect((await pass()).entries).toBe(0);
    await resetDesk({}, true);
    expect((await pass({ entries: false })).entries).toBe(0);
    await pass();
    expect((await position(mint)).status).toBe("open");
    await resetDesk({}, false);
    market.lamportsPerRaw.set(mint, priceFor(0.3));
    later(1);
    await pass({ entries: false });
    expect(await position(mint)).toMatchObject({ status: "closed", closeReason: "stop_loss" });
  });

  it("stops itself at the daily loss limit and says so", async () => {
    const { tokenId, mint } = await token("LOSS");
    await tradeVerdict(tokenId);
    await resetDesk({ dailyLossLimitSol: 0.1 });
    await pass();
    market.lamportsPerRaw.set(mint, priceFor(0.4));
    later(1);
    const s = await pass();
    expect(s.running).toBe(false);
    const desk = await prisma.fdsaDesk.findUniqueOrThrow({ where: { id: FDSA_DESK_ID } });
    expect(desk.running).toBe(false);
    expect(desk.pausedReason).toMatch(/lost/);
    expect(notes.some((n) => n.event === "loss_limit" && /FDSA/.test(n.html))).toBe(true);
  });

  it("sells on request from the tab, and retries a sale with no route", async () => {
    const { tokenId, mint } = await token("MANUAL");
    await tradeVerdict(tokenId);
    await pass();
    const p = await position(mint);
    await prisma.fdsaPosition.update({ where: { id: p.id }, data: { closeRequested: true } });
    market.noRoute.add(mint);
    later(1);
    await pass();
    expect(await position(mint)).toMatchObject({ status: "open", error: "no route (manual)" });
    market.noRoute.delete(mint);
    await pass();
    expect(await position(mint)).toMatchObject({ status: "closed", closeReason: "manual" });
  });
});
