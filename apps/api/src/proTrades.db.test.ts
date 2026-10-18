// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { ProTradeWatcher, type WalletTx } from "./proTrades.js";
import { tradedMint } from "./lookupGate.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const W = `protrades-test-${Date.now()}`;
const MINT = "CoinMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump";

function swap(sig: string, side: "buy" | "sell", at: number, held: [string, string]): WalletTx {
  return {
    blockTime: at,
    meta: {
      err: null,
      preBalances: [side === "buy" ? 2e9 : 1e9],
      postBalances: [side === "buy" ? 1.5e9 : 1.4e9],
      preTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: W, uiTokenAmount: { amount: held[0], decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: W, uiTokenAmount: { amount: held[1], decimals: 6 } },
      ],
    },
    transaction: { message: { accountKeys: [W] }, signatures: [sig] },
  } as WalletTx;
}

describe.skipIf(!dbAvailable)("ProTradeWatcher on the database", () => {
  afterAll(async () => {
    await prisma.proTrade.deleteMany({ where: { wallet: W } });
    await prisma.proTradeCursor.deleteMany({ where: { wallet: W } });
  });

  it("catches up, marks entries, scans each entry once, and never reads a transaction twice", async () => {
    const now = Date.now();
    const t0 = Math.floor(now / 1000) - 3_000;
    const txs = new Map<string, WalletTx>([
      ["s1", swap("s1", "buy", t0, ["0", "1000"])],
      ["s2", swap("s2", "sell", t0 + 60, ["1000", "0"])],
      ["s3", swap("s3", "buy", t0 + 120, ["0", "500"])],
    ]);
    let signatures = [
      { signature: "s3", blockTime: t0 + 120, failed: false },
      { signature: "s2", blockTime: t0 + 60, failed: false },
      { signature: "s1", blockTime: t0, failed: false },
    ];
    const reads: string[] = [];
    const entries: string[] = [];
    const watcher = new ProTradeWatcher({
      stream: null,
      rpc: {
        getSignaturesForAddress: async () => signatures,
        getTransactionJson: async (s) => {
          reads.push(s);
          return txs.get(s) ?? null;
        },
      },
      onEntry: async (_w, mint, at) => {
        entries.push(`${mint}@${at.getTime() / 1000}`);
      },
      now: () => now,
    });

    await watcher.catchUp(W);
    const rows = await prisma.proTrade.findMany({ where: { wallet: W }, orderBy: { at: "asc" } });
    expect(rows.map((r) => [r.signature, r.side, r.entry])).toEqual([
      ["s1", "buy", true],
      ["s2", "sell", false],
      ["s3", "buy", true],
    ]);
    expect(entries).toEqual([`${MINT}@${t0}`, `${MINT}@${t0 + 120}`]);
    expect(reads.sort()).toEqual(["s1", "s2", "s3"]);
    expect((await prisma.proTradeCursor.findUnique({ where: { wallet: W } }))?.lastSignature).toBe("s3");

    // A new transaction: only it is read; the stream had already delivered it, so not even that.
    txs.set("s4", swap("s4", "sell", t0 + 200, ["500", "0"]));
    signatures = [{ signature: "s4", blockTime: t0 + 200, failed: false }, ...signatures];
    watcher.onStreamTx(`pro-trades:${W}`, "s4", txs.get("s4")!);
    await new Promise((r) => setTimeout(r, 200));
    reads.length = 0;
    await watcher.catchUp(W);
    expect(reads).toEqual([]);
    expect(await prisma.proTrade.count({ where: { wallet: W } })).toBe(4);
    expect(entries).toHaveLength(2);
    expect((await prisma.proTradeCursor.findUnique({ where: { wallet: W } }))?.lastSignature).toBe("s4");

    // The trader's coin opens in the token modal for them, and only for them.
    expect(await tradedMint(W, MINT)).toBe(true);
    expect(await tradedMint(`${W}-other`, MINT)).toBe(false);
  });

  it("waits for a transaction the node hasn't served yet before moving the cursor past it", async () => {
    const wallet = `${W}-late`;
    const now = Date.now();
    const t0 = Math.floor(now / 1000) - 100;
    let served = false;
    const watcher = new ProTradeWatcher({
      stream: null,
      rpc: {
        getSignaturesForAddress: async () => [{ signature: "late1", blockTime: t0, failed: false }],
        getTransactionJson: async () =>
          served
            ? {
                ...swap("late1", "buy", t0, ["0", "7"]),
                transaction: { message: { accountKeys: [wallet] } },
                meta: {
                  ...swap("late1", "buy", t0, ["0", "7"]).meta!,
                  preTokenBalances: [],
                  postTokenBalances: [
                    {
                      accountIndex: 1,
                      mint: MINT,
                      owner: wallet,
                      uiTokenAmount: { amount: "7", decimals: 6 },
                    },
                  ],
                },
              }
            : null,
      },
      onEntry: async () => {},
      now: () => now,
    });
    try {
      await watcher.catchUp(wallet);
      expect(
        (await prisma.proTradeCursor.findUnique({ where: { wallet } }))?.lastSignature ?? null,
      ).toBeNull();
      served = true;
      await watcher.catchUp(wallet);
      expect(await prisma.proTrade.count({ where: { wallet } })).toBe(1);
      expect((await prisma.proTradeCursor.findUnique({ where: { wallet } }))?.lastSignature).toBe("late1");
    } finally {
      await prisma.proTrade.deleteMany({ where: { wallet } });
      await prisma.proTradeCursor.deleteMany({ where: { wallet } });
    }
  });
});
