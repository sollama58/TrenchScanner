// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KNOWN_EXCHANGE_WALLETS, loadEnv, prisma, type Env, type WalletFlows } from "@trenchscanner/core";
import { addExitTrace, biggestOut, exitNote, traceExits, type ExitTrace } from "./chain.js";
import { commonFunderNote, findCommonFunder, sharedFunders } from "./funders.js";
import { GraphBuilder } from "./graph.js";

/** Real ed25519 public keys, as wallets are. */
const [A, B, C, D, E, F] = [
  "2cER2peZXLpnJAaStnoDHmXAEmgzkEPMU2f1gbpT5ABv",
  "8faJMzdGivifdQUjtLuWVfmHLL5bXb3Ra8yrLFvpiFkS",
  "EACocApB8v6vmMme2jzxQKgjeG2W94EWUc2TWd9NvbHW",
  "42m2gj2LK29RHtmZLmXaRgj46azibjeAmW2TZYSD7p4h",
  "59t1Pby9UKkNP8mJ6BsYCnLR1L8c4ZpiQwFuU3sioUdx",
  "9fZTZQu5NQuTSKJPMWqAK21yDBSgiVN9XU2V76fBnAFj",
] as const;
const EXCHANGE = [...KNOWN_EXCHANGE_WALLETS.keys()][0]!;
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const flows = (wallet: string, outs: [string, number][]): WalletFlows => ({
  wallet,
  txs: outs.length,
  fromMs: null,
  toMs: null,
  transfers: outs.map(([to, sol]) => ({
    counterparty: to,
    dir: "out" as const,
    mint: null,
    amount: sol,
    count: 1,
    firstAt: null,
    lastAt: Date.UTC(2026, 9, 20),
  })),
  trades: [],
});

describe("exit trace", () => {
  it("follows the biggest SOL sent on, past dust and coin transfers", () => {
    const f = flows(A, [
      [B, 2],
      [C, 9],
      [D, 0.05],
    ]);
    f.transfers.push({ ...f.transfers[0]!, counterparty: E, mint: "SomeMint", amount: 1e6 });
    expect(biggestOut(f, new Set())).toMatchObject({ from: A, to: C, sol: 9 });
    expect(biggestOut(f, new Set([C]))).toMatchObject({ to: B });
    expect(biggestOut(flows(A, [[D, 0.05]]), new Set())).toBeNull();
  });
  it("says where the money ended", () => {
    const t = (path: string[], stop: ExitTrace["stop"], sol = 9): ExitTrace => ({
      path,
      stop,
      asked: 0,
      hops: path.slice(1).map((to, i) => ({ from: path[i]!, to, sol, count: 1, lastAt: null })),
    });
    expect(exitNote(t([A, B, EXCHANGE], "exchange"), "Binance")).toBe(
      "Followed the money 2 hops. It ends at Binance, an exchange or service wallet, 9 SOL sent from the start.",
    );
    expect(exitNote(t([A], "cold"))).toMatch(/^It sent no SOL on/);
    const g = new GraphBuilder();
    addExitTrace(g, t([A, B, EXCHANGE], "exchange"));
    expect(g.graph().edges.map((e) => `${e.a}>${e.b}:${e.kind}`)).toEqual([
      `${A}>${B}:transfer`,
      `${B}>${EXCHANGE}:transfer`,
    ]);
    expect(g.get(EXCHANGE)?.tags).toEqual(["exchange"]);
  });
});

describe.skipIf(!dbAvailable)("traceExits", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ASYL_USER_DAILY_CREDITS: 3000, ASYL_DAILY_CREDITS: 150_000 }
    : (undefined as never);
  const userId = "asyl-exits-test";
  const now = Date.now();
  const helius = {
    async getWalletTransactionsPage(): Promise<never> {
      throw new Error("kept reads only");
    },
  };
  const cleanup = async () => {
    await prisma.asylFlowRead.deleteMany({ where: { wallet: { in: [A, B, C, D] } } });
    await prisma.asylCreditUse.deleteMany({ where: { userId } });
  };
  beforeAll(async () => {
    await cleanup();
    const keep = (f: WalletFlows) =>
      prisma.asylFlowRead.create({
        data: { wallet: f.wallet, readAt: new Date(now), flows: f as never, txs: 1 },
      });
    await keep(flows(A, [[B, 5]]));
    await keep(flows(B, [[EXCHANGE, 4.8]]));
    await keep(flows(C, [[D, 3]]));
    await keep(flows(D, []));
  });
  afterAll(cleanup);

  it("stops at an exchange, or where the money stopped moving, from kept reads for free", async () => {
    const out = await traceExits(env, helius, userId, A, now);
    expect(out).toMatchObject({
      cached: true,
      credits: 0,
      value: { path: [A, B, EXCHANGE], stop: "exchange" },
    });
    const cold = await traceExits(env, helius, userId, C, now);
    expect(cold).toMatchObject({ value: { path: [C, D], stop: "cold" } });
  });
});

describe.skipIf(!dbAvailable)("common funder", () => {
  // F paid E, E paid A and B; F also paid C directly; D was paid by an exchange.
  const rows = [
    { wallet: A, funder: E },
    { wallet: B, funder: E },
    { wallet: E, funder: F },
    { wallet: C, funder: F },
    { wallet: D, funder: EXCHANGE },
  ];
  const cleanup = () => prisma.walletFunder.deleteMany({ where: { wallet: { in: [A, B, C, D, E, F] } } });
  beforeAll(async () => {
    await cleanup();
    await prisma.walletFunder.createMany({
      data: rows.map((r) => ({ ...r, status: "found", amountSol: 1 })),
    });
  });
  afterAll(cleanup);

  it("finds the nearest wallet that paid for most of them, and leaves exchanges out", async () => {
    const g = new GraphBuilder();
    const read = await findCommonFunder(g, [A, B, C, D]);
    expect(read.best).toEqual({
      funder: F,
      wallets: [
        { wallet: A, hops: 2 },
        { wallet: B, hops: 2 },
        { wallet: C, hops: 1 },
      ],
    });
    expect(read.shared.map((s) => s.funder)).toEqual([F, E]);
    expect(read.exchanges).toEqual([EXCHANGE]);
    const funded = g.graph().edges.map((e) => `${e.a}>${e.b}`);
    expect(funded.sort()).toEqual(
      [`${E}>${A}`, `${E}>${B}`, `${F}>${E}`, `${F}>${C}`, `${EXCHANGE}>${D}`].sort(),
    );
    expect(commonFunderNote(read, 4, (w) => w.slice(0, 4))).toBe(
      "9fZT paid for 3 of the 4, within 2 hops. 1 more shared funder found.",
    );
    const two = await findCommonFunder(new GraphBuilder(), [A, B]);
    expect(two.best?.funder).toBe(E);
  });

  it("counts one of the wallets paying the others", () => {
    const s = sharedFunders(
      new Map([
        [A, [A]],
        [B, [B, A]],
      ]),
      new Set(),
    );
    expect(s).toEqual([
      {
        funder: A,
        wallets: [
          { wallet: A, hops: 0 },
          { wallet: B, hops: 1 },
        ],
      },
    ]);
  });
});
