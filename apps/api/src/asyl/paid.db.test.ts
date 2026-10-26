// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BRIDGE_PROGRAMS,
  grantCredits,
  KNOWN_EXCHANGE_WALLETS,
  loadEnv,
  prisma,
  type Env,
  type WalletFlows,
} from "@trenchscanner/core";
import { GraphBuilder } from "./graph.js";
import {
  addBridges,
  addDeposits,
  asDeposit,
  bridgeNode,
  bridgeNote,
  burnCheck,
  burnId,
  chargeFor,
  depositCandidates,
  depositNote,
  findSharedDeposits,
  PAID_COST,
} from "./paid.js";

/** Real ed25519 public keys, as wallets are. */
const [A, B, C, D, E] = [
  "2cER2peZXLpnJAaStnoDHmXAEmgzkEPMU2f1gbpT5ABv",
  "8faJMzdGivifdQUjtLuWVfmHLL5bXb3Ra8yrLFvpiFkS",
  "EACocApB8v6vmMme2jzxQKgjeG2W94EWUc2TWd9NvbHW",
  "42m2gj2LK29RHtmZLmXaRgj46azibjeAmW2TZYSD7p4h",
  "59t1Pby9UKkNP8mJ6BsYCnLR1L8c4ZpiQwFuU3sioUdx",
] as const;
const EXCHANGE = [...KNOWN_EXCHANGE_WALLETS.keys()][0]!;
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const AT = Date.UTC(2026, 9, 20);

/** A flow read with SOL transfers: [counterparty, dir, sol, count]. */
const flows = (wallet: string, moves: [string, "in" | "out", number, number?][]): WalletFlows => ({
  wallet,
  txs: moves.length,
  fromMs: null,
  toMs: null,
  transfers: moves.map(([counterparty, dir, amount, count]) => ({
    counterparty,
    dir,
    mint: null,
    amount,
    count: count ?? 1,
    firstAt: AT,
    lastAt: AT,
  })),
  trades: [],
  bridges: [],
});

describe("exchange deposits", () => {
  it("checks where it sent most often, leaving exchanges out", () => {
    const f = flows(A, [
      [EXCHANGE, "out", 50, 9],
      [B, "out", 1, 5],
      [C, "out", 20, 1],
      [D, "in", 3, 7],
    ]);
    expect(depositCandidates(f, new Set([EXCHANGE]))).toEqual([B, C]);
  });

  it("reads a wallet that sweeps nearly all it gets to an exchange as a deposit address", () => {
    const hot = new Set([EXCHANGE]);
    const d = asDeposit(
      flows(B, [
        [A, "in", 2, 3],
        [C, "in", 4, 2],
        [EXCHANGE, "out", 6, 5],
      ]),
      hot,
    );
    expect(d).toMatchObject({ exchange: EXCHANGE, swept: { sol: 6, count: 5 } });
    expect(d!.depositors.map((x) => x.wallet)).toEqual([A, C]);
    // A wallet paying people too is someone's wallet, not a deposit address.
    expect(
      asDeposit(
        flows(B, [
          [EXCHANGE, "out", 6, 2],
          [D, "out", 1, 2],
        ]),
        hot,
      ),
    ).toBeNull();
    expect(asDeposit(flows(B, [[A, "in", 2]]), hot)).toBeNull();
  });

  it("draws and says what it found", () => {
    const cluster = {
      wallet: A,
      checked: 2,
      stop: "done" as const,
      asked: 0,
      deposits: [
        {
          address: B,
          exchange: EXCHANGE,
          sent: { sol: 2, count: 3, lastAt: AT },
          swept: { sol: 6, count: 5, lastAt: AT },
          depositors: [{ wallet: C, sol: 4, count: 2, lastAt: AT }],
        },
      ],
    };
    const g = new GraphBuilder();
    addDeposits(g, cluster);
    expect(g.graph().edges.map((e) => `${e.a}>${e.b}`)).toEqual([
      `${A}>${B}`,
      `${B}>${EXCHANGE}`,
      `${C}>${B}`,
    ]);
    expect(g.get(B)?.tags).toEqual(["deposit"]);
    expect(depositNote(cluster, new Map([[EXCHANGE, "Binance"]]))).toBe(
      `It pays an exchange deposit address: ${B.slice(0, 4)}…${B.slice(-4)} (to Binance). 1 other wallet paid into the same address: most likely the same person's exchange account.`,
    );
    expect(depositNote({ ...cluster, deposits: [] })).toMatch(/^None of the 2 wallets it paid most/);
  });
});

describe("bridges", () => {
  it("draws one line per bridge, way and coin, to one node per bridge", () => {
    const programs = [...BRIDGE_PROGRAMS].filter(([, n]) => n === "Wormhole").map(([p]) => p);
    const g = new GraphBuilder();
    addBridges(g, A, [
      {
        bridge: "Wormhole",
        program: programs[0]!,
        dir: "out",
        mint: null,
        amount: 2,
        at: AT,
        signature: "s1",
      },
      {
        bridge: "Wormhole",
        program: programs[1]!,
        dir: "out",
        mint: null,
        amount: 3,
        at: AT,
        signature: "s2",
      },
      { bridge: "Mayan", program: "x", dir: "in", mint: "usdc", amount: 100, at: AT, signature: "s3" },
    ]);
    const edges = g.graph().edges;
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ a: A, b: bridgeNode("Wormhole"), sol: 5 });
    expect(edges[0]!.label).toMatch(/^Bridged out 5 SOL via Wormhole · 2×/);
    expect(edges[1]).toMatchObject({ a: bridgeNode("Mayan"), b: A, mint: "usdc", tokens: 100 });
    expect(g.get(bridgeNode("Wormhole"))?.tags).toEqual(["bridge"]);
  });

  it("says what it found", () => {
    expect(bridgeNote(flows(A, []))).toMatch(/^No bridge moves in its last 0 transactions/);
    const f = flows(A, []);
    f.txs = 300;
    f.bridges = [
      { bridge: "Wormhole", program: "p", dir: "out", mint: null, amount: 4, at: AT, signature: null },
      { bridge: "Mayan", program: "q", dir: "in", mint: "usdc", amount: 9, at: AT, signature: null },
    ];
    expect(bridgeNote(f)).toBe(
      "2 bridge moves in its last 300 transactions: 1 out (4 SOL) through Wormhole; 1 in through Mayan. Open each on Solscan to see the other chain.",
    );
  });
});

describe.skipIf(!dbAvailable)("paid in Burn Credits", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ASYL_USER_DAILY_CREDITS: 3000, ASYL_DAILY_CREDITS: 150_000 }
    : (undefined as never);
  const READER = "AsyPaidReader" + "1".repeat(31);
  const userId = "asyl-paid-test";
  const now = Date.now();
  const helius = {
    async getWalletTransactionsPage(): Promise<never> {
      throw new Error("kept reads only");
    },
  };
  const cleanup = async () => {
    await prisma.burnCreditEntry.deleteMany({ where: { wallet: READER } });
    await prisma.asylFlowRead.deleteMany({ where: { wallet: { in: [A, B, C, D, E] } } });
    await prisma.asylCreditUse.deleteMany({ where: { userId: { in: [userId, burnId(userId)] } } });
  };
  beforeAll(async () => {
    await cleanup();
    const keep = (f: WalletFlows) =>
      prisma.asylFlowRead.create({
        data: { wallet: f.wallet, readAt: new Date(now), flows: f as never, txs: 1 },
      });
    // A pays B (a deposit address, swept to the exchange) and D (someone's wallet); E pays B too.
    await keep(
      flows(A, [
        [B, "out", 2, 3],
        [D, "out", 1, 1],
      ]),
    );
    await keep(
      flows(B, [
        [A, "in", 2, 3],
        [E, "in", 4, 2],
        [EXCHANGE, "out", 6, 5],
      ]),
    );
    await keep(flows(D, [[C, "out", 1, 1]]));
  });
  afterAll(cleanup);

  it("needs the credits, charges once the read works, and re-opens free within the hour", async () => {
    expect(await burnCheck(env, READER, "asyl-deposits", A)).toEqual({
      ok: false,
      balance: 0,
      cost: PAID_COST["asyl-deposits"],
      freeLeft: 0,
    });
    await grantCredits(READER, 5, "asyl paid test");
    expect(await burnCheck(env, READER, "asyl-deposits", A)).toEqual({ ok: true, dailyFree: false });

    const res = await findSharedDeposits(env, helius, userId, A, now);
    expect(res).toMatchObject({ cached: true, credits: 0, value: { checked: 2, stop: "done" } });
    if ("refused" in res) throw new Error("refused");
    expect(res.value.deposits).toEqual([
      expect.objectContaining({
        address: B,
        exchange: EXCHANGE,
        depositors: [expect.objectContaining({ wallet: E })],
      }),
    ]);

    expect(await chargeFor(READER, "asyl-deposits", A, false)).toMatchObject({
      status: "charged",
      cost: 3,
      balance: 2,
    });
    expect(await chargeFor(READER, "asyl-deposits", A, false)).toMatchObject({
      status: "reopened",
      balance: 2,
    });
    // The other tool, or another wallet, is a new charge.
    expect(await burnCheck(env, READER, "asyl-deposits", B)).toMatchObject({ ok: false, balance: 2 });
    expect(await chargeFor(READER, "asyl-bridges", A, false)).toMatchObject({
      status: "charged",
      cost: 1,
      balance: 1,
    });
  });
});
