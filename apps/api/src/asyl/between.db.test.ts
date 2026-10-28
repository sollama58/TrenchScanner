// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, prisma, type ChainTx, type Env } from "@trenchscanner/core";
import {
  betweenRead,
  betweenWorst,
  clearBetweenCache,
  keptBetween,
  meteredBetween,
  mergeBetween,
  movesIn,
  readBetweenChain,
  type BetweenTransfer,
} from "./between.js";

/** Real ed25519 public keys: counterparties must be on the curve, as wallets are. */
const [A, B, C, OTHER] = [
  "2cER2peZXLpnJAaStnoDHmXAEmgzkEPMU2f1gbpT5ABv",
  "8faJMzdGivifdQUjtLuWVfmHLL5bXb3Ra8yrLFvpiFkS",
  "EACocApB8v6vmMme2jzxQKgjeG2W94EWUc2TWd9NvbHW",
  "59t1Pby9UKkNP8mJ6BsYCnLR1L8c4ZpiQwFuU3sioUdx",
] as const;
const MINT = "BetweenMint1111111111111111111111111111111";
const SOL = 1_000_000_000;
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

/** `from` sends `to` SOL. */
const solTx = (from: string, to: string, sol: number, at: number): ChainTx =>
  ({
    blockTime: at,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [10 * SOL, 1 * SOL],
      postBalances: [10 * SOL - sol * SOL - 5000, 1 * SOL + sol * SOL],
    },
    transaction: { message: { accountKeys: [from, to] } },
  }) as ChainTx;

/** `from` sends `to` coins of MINT, its token account to theirs. */
const coinTx = (from: string, to: string, coins: number, at: number): ChainTx =>
  ({
    blockTime: at,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [10 * SOL, 2_039_280, 2_039_280],
      postBalances: [10 * SOL - 5000, 2_039_280, 2_039_280],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: MINT,
          owner: from,
          uiTokenAmount: { amount: String(1000 * 1e6), decimals: 6 },
        },
        { accountIndex: 2, mint: MINT, owner: to, uiTokenAmount: { amount: "0", decimals: 6 } },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: MINT,
          owner: from,
          uiTokenAmount: { amount: String((1000 - coins) * 1e6), decimals: 6 },
        },
        {
          accountIndex: 2,
          mint: MINT,
          owner: to,
          uiTokenAmount: { amount: String(coins * 1e6), decimals: 6 },
        },
      ],
    },
    transaction: {
      message: {
        accountKeys: [
          from,
          "TokAcctFrom11111111111111111111111111111111",
          "TokAcctTo111111111111111111111111111111111",
        ],
      },
    },
  }) as unknown as ChainTx;

describe("movesIn", () => {
  it("reads a SOL send and a coin send once each, from the sender's side", () => {
    expect(movesIn(solTx(A, B, 2, 1_700_000_000), "sig1", [A, B])).toEqual([
      expect.objectContaining({
        from: A,
        to: B,
        mint: null,
        amount: 2,
        at: 1_700_000_000_000,
        source: "chain",
      }),
    ]);
    expect(movesIn(coinTx(B, A, 250, 1_700_000_100), "sig2", [A, B, C])).toEqual([
      expect.objectContaining({ from: B, to: A, mint: MINT, amount: 250, signature: "sig2" }),
    ]);
  });

  it("leaves out a move to a wallet outside the set", () => {
    expect(movesIn(solTx(A, OTHER, 2, 1_700_000_000), "sig3", [A, B])).toEqual([]);
  });
});

describe("mergeBetween", () => {
  const row = (over: Partial<BetweenTransfer>): BetweenTransfer => ({
    signature: "s",
    at: 1000,
    from: A,
    to: B,
    mint: null,
    amount: 1,
    pct: null,
    kind: "transfer",
    source: "stored",
    ...over,
  });
  it("shows a transaction both have once, as the chain read it, and a first funding the chain found as its transfer", () => {
    const stored = [
      row({ signature: "x", mint: MINT, amount: null, pct: 0.5 }),
      row({ signature: null, kind: "funding", at: 5_000 }),
      row({ signature: "old", mint: MINT, at: 10 }),
    ];
    const chain = [
      row({ signature: "x", mint: MINT, amount: 40, source: "chain" }),
      row({ signature: "f", at: 20_000, source: "chain" }),
    ];
    const merged = mergeBetween(stored, chain);
    expect(merged.map((t) => [t.signature, t.source])).toEqual([
      ["f", "chain"],
      ["x", "chain"],
      ["old", "stored"],
    ]);
  });
});

describe("readBetweenChain", () => {
  beforeEach(clearBetweenCache);
  const txs = new Map<string, ChainTx>([
    ["ab", solTx(A, B, 1.5, 1_700_000_300)],
    ["ba", coinTx(B, A, 10, 1_700_000_200)],
    ["ac", solTx(A, C, 0.5, 1_700_000_100)],
  ]);
  const lists: Record<string, string[]> = {
    [A]: ["ab", "ba", "ac", "a-only"],
    [B]: ["ab", "ba", "b-only"],
    [C]: ["ac"],
  };
  const fake = () => {
    const asked = { pages: 0, txs: [] as string[] };
    const helius = {
      async getWalletSignaturesPage(w: string) {
        asked.pages += 1;
        return {
          status: "ok" as const,
          sigs: (lists[w] ?? []).map((signature) => ({ signature, at: 1_700_000_000_000 })),
          paginationToken: null,
        };
      },
      async getTransactionsBatch(sigs: readonly string[]) {
        asked.txs.push(...sigs);
        return new Map(sigs.map((s) => [s, txs.get(s) ?? null]));
      },
    };
    return { helius, asked };
  };

  it("reads only the transactions two or more of the wallets share, and every move among them", async () => {
    const { helius, asked } = fake();
    const r = await readBetweenChain(helius, [A, B, C], 1_000);
    expect(r).not.toBeNull();
    expect(asked.pages).toBe(3);
    expect(asked.txs.sort()).toEqual(["ab", "ac", "ba"]);
    expect(r!.transfers.map((t) => [t.signature, t.from, t.to, t.mint]).sort()).toEqual([
      ["ab", A, B, null],
      ["ac", A, C, null],
      ["ba", B, A, MINT],
    ]);
    expect(r!.chain).toMatchObject({ shared: 3, read: 3, stop: "done" });
    expect(r!.chain.covers.every((c) => c.complete)).toBe(true);
    // Kept for everyone: the same set, in any order, is free.
    expect(keptBetween([C, B, A])?.transfers).toHaveLength(3);
  });

  it("reads no more shared transactions than the credits left cover, and says so", async () => {
    const { helius, asked } = fake();
    // Two pages (20) and one transaction.
    const r = await readBetweenChain(helius, [A, B], 21);
    expect(asked.txs).toEqual(["ab"]);
    expect(r!.chain).toMatchObject({ shared: 2, read: 1, stop: "allowance" });
    expect(keptBetween([A, B])).toBeNull();
  });

  it("gives no answer when the wallets can't be listed", async () => {
    const helius = {
      async getWalletSignaturesPage() {
        return { status: "failed" as const };
      },
      async getTransactionsBatch() {
        return new Map();
      },
    };
    expect(await readBetweenChain(helius, [A, B], 1_000)).toBeNull();
  });
});

describe.skipIf(!dbAvailable)("betweenRead and meteredBetween", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ASYL_USER_DAILY_CREDITS: 3_000, ASYL_DAILY_CREDITS: 150_000 }
    : (undefined as never);
  const userId = "asyl-between-test-user";
  const cleanup = async () => {
    await prisma.holderTransferEvent.deleteMany({ where: { fromWallet: { in: [A, B, C] } } });
    await prisma.walletFunder.deleteMany({ where: { wallet: { in: [A, B, C] } } });
    await prisma.asylCreditUse.deleteMany({ where: { userId } });
    clearBetweenCache();
  };
  beforeAll(cleanup);
  afterAll(cleanup);

  it("answers the stored transfers among the set, free, and none with a wallet outside it", async () => {
    await prisma.holderTransferEvent.createMany({
      data: [
        {
          signature: "held1",
          fromWallet: A,
          toWallet: B,
          mintAddress: MINT,
          pct: 0.4,
          at: new Date(1_700_000_000_000),
        },
        {
          signature: "held2",
          fromWallet: A,
          toWallet: OTHER,
          mintAddress: MINT,
          pct: 1,
          at: new Date(1_700_000_000_000),
        },
      ],
    });
    await prisma.walletFunder.create({
      data: { wallet: C, status: "found", funder: B, amountSol: 3, fundedAt: new Date(1_690_000_000_000) },
    });
    const r = await betweenRead([A, B, C], null);
    expect(r.chain).toBeNull();
    expect(r.transfers.map((t) => [t.kind, t.from, t.to, t.signature])).toEqual([
      ["transfer", A, B, "held1"],
      ["funding", B, C, null],
    ]);
  });

  it("meters a chain read against the reader's allowance and keeps it, free the next time", async () => {
    const helius = {
      async getWalletSignaturesPage(w: string) {
        return {
          status: "ok" as const,
          sigs: w === OTHER ? [] : [{ signature: "pair", at: 1_700_000_500_000 }],
          paginationToken: null,
        };
      },
      async getTransactionsBatch(sigs: readonly string[]) {
        return new Map(sigs.map((s) => [s, solTx(A, B, 1, 1_700_000_500)]));
      },
    };
    const first = await meteredBetween(env, helius, userId, [A, B]);
    expect("refused" in first).toBe(false);
    if ("refused" in first) return;
    expect(first.cached).toBe(false);
    expect(first.value.transfers).toEqual([expect.objectContaining({ signature: "pair", from: A, to: B })]);
    const again = await meteredBetween(env, helius, "someone-else", [B, A]);
    expect(again).toMatchObject({ cached: true, credits: 0 });
    const read = await betweenRead([A, B], first.value);
    expect(read.transfers.map((t) => t.signature)).toEqual(["pair", "held1"]);
  });

  it("refuses a chain read the allowance can't start", async () => {
    clearBetweenCache();
    const short: Env = { ...env, ASYL_USER_DAILY_CREDITS: 5 };
    const helius = {
      async getWalletSignaturesPage() {
        return { status: "ok" as const, sigs: [], paginationToken: null };
      },
      async getTransactionsBatch() {
        return new Map();
      },
    };
    expect(await meteredBetween(short, helius, userId, [A, B])).toMatchObject({ refused: "allowance" });
    expect(betweenWorst(6)).toBe(500);
  });
});
