// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { associatedTokenAddress, prisma, type ChainTx, type TapeTrade } from "@trenchscanner/core";
import {
  CLOSING_AFTER_ANCHOR_MS,
  foldClosingTrades,
  resetClosingState,
  runClosingLane,
  sellersOf,
  type ClosingCounts,
  type ClosingHelius,
  type ClosingRow,
} from "./tradeTapeClosing.js";

const MIN = 60_000;

describe("foldClosingTrades", () => {
  const row: ClosingRow = {
    buys: 1,
    sells: 0,
    solIn: 2,
    solOut: 0,
    tokensBought: 50_000_000,
    tokensSold: 0,
    firstBuyAt: new Date(1_000),
    firstSellAt: null,
    boughtPct: 5,
    fastExit: false,
    trades: [[1_000, 1, 2, 50_000_000]],
  };
  const t = (side: "buy" | "sell", sol: number, tokens: number, atMs: number): TapeTrade => ({
    wallet: "w",
    side,
    sol,
    tokens,
    atMs,
    tx: `${side}-${atMs}`,
  });

  it("adds the later sells, with their own times and amounts", () => {
    const out = foldClosingTrades(row, [
      t("sell", 0.5, 20_000_000, 90 * MIN),
      t("sell", 0.2, 30_000_000, 95 * MIN),
    ]);
    expect(out).toMatchObject({ sells: 2, solOut: 0.7, tokensSold: 50_000_000, buys: 1, solIn: 2 });
    expect(out.firstSellAt).toEqual(new Date(90 * MIN));
    expect(out.fastExit).toBe(false);
    expect(out.trades).toEqual([
      [1_000, 1, 2, 50_000_000],
      [90 * MIN, -1, 0.5, 20_000_000],
      [95 * MIN, -1, 0.2, 30_000_000],
    ]);
  });

  it("keeps an earlier first sell and adds later buys to the bought share", () => {
    const out = foldClosingTrades({ ...row, sells: 1, firstSellAt: new Date(2_000) }, [
      t("buy", 1, 10_000_000, 90 * MIN),
    ]);
    expect(out.firstSellAt).toEqual(new Date(2_000));
    expect(out.buys).toBe(2);
    expect(out.boughtPct).toBeCloseTo(6);
  });

  it("keeps the first and last halves of a long list", () => {
    const many = Array.from({ length: 250 }, (_, i) => t("buy", 0.1, 1, 60 * MIN + i));
    const out = foldClosingTrades(row, many);
    expect(out.trades).toHaveLength(200);
    expect(out.trades[0]).toEqual([1_000, 1, 2, 50_000_000]);
    expect(out.trades.at(-1)![0]).toBe(60 * MIN + 249);
  });
});

describe("sellersOf", () => {
  const r = (wallet: string, tokensBought: number, tokensSold: number) => ({
    wallet,
    tokensBought,
    tokensSold,
  });

  it("finds the wallets that held at the window's end and hold less now, largest first", () => {
    const rows = [
      r("small", 10_000_000, 0),
      r("big", 50_000_000, 0),
      r("keeps", 20_000_000, 0),
      r("out", 5e6, 5e6),
    ];
    const now = new Map([
      ["keeps", 20_000_000],
      ["small", 2_000_000],
    ]);
    expect(sellersOf(rows, now).map((x) => x.wallet)).toEqual(["big", "small"]);
  });

  it("does not count a rounding difference as a sale", () => {
    expect(sellersOf([r("a", 50_000_000, 0)], new Map([["a", 49_900_000]]))).toEqual([]);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
// Far from every other test's tapes, so none of theirs is inside the lookback.
const NOW = Date.parse("2031-01-10T00:00:00Z");
const ANCHOR = NOW - CLOSING_AFTER_ANCHOR_MS - 10 * MIN;
const WINDOW_END = ANCHOR + 30 * MIN;
// Real wallet addresses: program accounts (off the ed25519 curve) are left out of the tape.
const seller = "4WPT9wLwQWYS5zyX36ZgoY3ESxxLgDmE12upKXDAyYbL";
const keeper = "E8UYm3eH1vod7a2kpkWotNyosY2W7x6K9yCDZbkqwW12";
const LEGACY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const counts = (): ClosingCounts => ({
  closingDone: 0,
  closingFailed: 0,
  closingSellers: 0,
  closingWallets: 0,
  closingCredits: 0,
});

/** Real mint addresses (the associated accounts are derived from them), one per seeded coin. */
const MINTS = [
  "51yFbJwn4nZNv9BdG4g15sV61j8yZRXfwnvPUKV2pump",
  "9zHKZ14uki54GAHqs75sXshQstqhqxY6bXPb3r9Apump",
  "BadHgRkP5AusMppqZT5zAAUcfvuG1wft56T5p247pump",
  "EA9cRajgtYr11aLaWP6i66UuKbATHkmUGx1Rv2Abpump",
  "DCmAqQgTnBWoHvGv1nzQZsyQRaAWjzMGsknfoZ9hpump",
  "EWtmECczHgregwQQ4WArXKGX8cBhEvK8FLDp6bqapump",
];
let nextMint = 0;
const mintFor = () => MINTS[nextMint++ % MINTS.length]!;
const seeded: string[] = [];

async function seedTape(mcap: number | null) {
  const token = await prisma.token.create({
    data: {
      mintAddress: mintFor(),
      ...(mcap !== null ? { liveMarketCapUsd: mcap, liveDataAt: new Date(NOW - MIN) } : {}),
    },
  });
  await prisma.tokenTradeTape.create({
    data: {
      tokenId: token.id,
      anchorAt: new Date(ANCHOR),
      reason: "called",
      status: "done",
      source: "helius",
      windowEnd: new Date(WINDOW_END),
    },
  });
  for (const wallet of [seller, keeper]) {
    await prisma.tokenWalletActivity.create({
      data: {
        tokenId: token.id,
        wallet,
        buys: 1,
        solIn: 2,
        tokensBought: 50_000_000,
        firstBuyAt: new Date(ANCHOR - MIN),
        heldAtAnchor: 50_000_000,
        heldPctAtAnchor: 5,
        boughtPct: 5,
        trades: [[ANCHOR - MIN, 1, 2, 50_000_000]],
      },
    });
  }
  seeded.push(token.id);
  return token;
}

function chainTx(
  mint: string,
  atMs: number,
  owner: string,
  pre: number,
  post: number,
  lamports: number,
): ChainTx {
  const bal = (amount: number) => ({
    accountIndex: 1,
    mint,
    owner,
    uiTokenAmount: { amount: String(amount * 1e6), decimals: 6 },
  });
  return {
    blockTime: atMs / 1000,
    transaction: { signatures: [`${owner}-${atMs}`], message: { accountKeys: [owner, "ata"] } },
    meta: {
      err: null,
      preTokenBalances: pre ? [bal(pre)] : [],
      postTokenBalances: [bal(post)],
      preBalances: [10e9, 0],
      postBalances: [10e9 + lamports, 0],
    },
  };
}

/** A Helius stand-in: the keeper still holds everything, the seller sold out and closed its account. */
function heliusFor(mint: string, sells: ChainTx[], asked: string[] = []): ClosingHelius {
  const sellerAta = associatedTokenAddress(seller, mint, LEGACY);
  return {
    getTopHoldersBatch: async () =>
      new Map([
        [mint, { status: "found" as const, holders: [{ owner: keeper, pct: 5, accounts: ["keeper-ata"] }] }],
      ]),
    getAccountSignaturesBatch: async (reads) => {
      asked.push(...reads.map((r) => r.address));
      return new Map(
        reads.map((r) => [
          r.address,
          {
            status: "found" as const,
            full: false,
            signatures:
              r.address === sellerAta
                ? [
                    ...sells.map((t) => ({
                      signature: t.transaction!.signatures![0]!,
                      ok: true,
                      atMs: t.blockTime! * 1000,
                    })),
                    // Inside the window: already on the tape.
                    { signature: "old", ok: true, atMs: WINDOW_END - MIN },
                  ]
                : [],
          },
        ]),
      );
    },
    getTransactionsBatch: async (sigs) =>
      new Map(sigs.map((sig) => [sig, sells.find((t) => t.transaction!.signatures![0] === sig) ?? null])),
  };
}

describe.skipIf(!dbAvailable)("closing read", () => {
  beforeEach(async () => {
    resetClosingState();
    await prisma.token.deleteMany({ where: { id: { in: seeded.splice(0) } } });
  });
  afterAll(async () => {
    if (dbAvailable) await prisma.token.deleteMany({ where: { id: { in: seeded } } });
  });

  it("folds the later sells of the tape's sellers into their rows, once", async () => {
    const token = await seedTape(2_500);
    const mint = token.mintAddress;
    const sells = [
      chainTx(mint, WINDOW_END + 2 * 3_600_000, seller, 50_000_000, 20_000_000, 0.4e9),
      chainTx(mint, WINDOW_END + 5 * 3_600_000, seller, 20_000_000, 0, 0.1e9),
    ];
    const asked: string[] = [];
    const c = counts();
    await runClosingLane(
      { helius: heliusFor(mint, sells, asked) },
      { budget: 30, floorUsd: 4_000 },
      c,
      () => NOW,
    );
    // Only the seller's accounts are read (both programs: its account is gone); the keeper's aren't.
    expect(asked.sort()).toEqual(
      [
        associatedTokenAddress(seller, mint, LEGACY),
        associatedTokenAddress(seller, mint, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
      ].sort(),
    );
    // Program and supply, the holder page, two signature reads, two transactions.
    expect(c).toMatchObject({ closingDone: 1, closingSellers: 1, closingWallets: 1, closingCredits: 6 });
    const row = await prisma.tokenWalletActivity.findFirstOrThrow({
      where: { tokenId: token.id, wallet: seller },
    });
    expect(row).toMatchObject({ sells: 2, tokensSold: 50_000_000, heldAtAnchor: 50_000_000 });
    expect(row.solOut).toBeCloseTo(0.5);
    expect(row.firstSellAt).toEqual(new Date(WINDOW_END + 2 * 3_600_000));
    expect(row.trades).toHaveLength(3);
    const kept = await prisma.tokenWalletActivity.findFirstOrThrow({
      where: { tokenId: token.id, wallet: keeper },
    });
    expect(kept.sells).toBe(0);
    const tape = await prisma.tokenTradeTape.findUniqueOrThrow({ where: { tokenId: token.id } });
    expect(tape).toMatchObject({ closeStatus: "done", closeTrades: 2, closeCalls: 6 });
    expect(tape.closedThrough).toEqual(new Date(NOW));
    // Closed for good: nothing more to read.
    const again = counts();
    await runClosingLane(
      { helius: heliusFor(mint, sells) },
      { budget: 30, floorUsd: 4_000 },
      again,
      () => NOW + MIN,
    );
    expect(again.closingCredits).toBe(0);
  });

  it("waits on a coin still over the floor, and judges a coin with no market dead", async () => {
    const alive = await seedTape(50_000);
    const gone = await seedTape(null);
    const read: string[] = [];
    const helius: ClosingHelius = {
      ...heliusFor(gone.mintAddress, []),
      getTopHoldersBatch: async (mints) => {
        read.push(...mints);
        return new Map(mints.map((m) => [m, { status: "found" as const, holders: [] }]));
      },
    };
    const marketCaps = async (mints: string[]) => new Map(mints.map((m) => [m, null] as const));
    await runClosingLane({ helius, marketCaps }, { budget: 30, floorUsd: 4_000 }, counts(), () => NOW);
    expect(read).toEqual([gone.mintAddress]);
    const waiting = await prisma.tokenTradeTape.findUniqueOrThrow({ where: { tokenId: alive.id } });
    expect(waiting.closeStatus).toBe("waiting");
    expect(waiting.closeRetryAt!.getTime()).toBeGreaterThan(NOW);
  });

  it("leaves a coin whose market cap could not be read for a later run", async () => {
    await seedTape(null);
    const c = counts();
    await runClosingLane(
      { helius: heliusFor(mintFor(), []), marketCaps: async () => new Map<string, number | null>() },
      { budget: 30, floorUsd: 4_000 },
      c,
      () => NOW,
    );
    expect(c.closingCredits).toBe(0);
  });

  it("retries a coin whose holders could not be read", async () => {
    const token = await seedTape(1_000);
    const helius: ClosingHelius = {
      ...heliusFor(token.mintAddress, []),
      getTopHoldersBatch: async (mints) => new Map(mints.map((m) => [m, { status: "failed" as const }])),
    };
    const c = counts();
    await runClosingLane({ helius }, { budget: 30, floorUsd: 4_000 }, c, () => NOW);
    expect(c.closingFailed).toBe(1);
    const tape = await prisma.tokenTradeTape.findUniqueOrThrow({ where: { tokenId: token.id } });
    expect(tape.closeStatus).toBe("failed");
    expect(tape.closeRetryAt!.getTime()).toBeGreaterThan(NOW);
  });
});
