// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type ChainTx, type Env } from "@trenchscanner/core";
import { allowanceOf, recordSpend, utcDay } from "./credits.js";
import { FLOW_WORST, readWalletFlows, refreshFunders } from "./chain.js";

const addr = (prefix: string) => prefix + "1".repeat(43 - prefix.length);
const WALLET = addr("AsyFlowMe");
/** A real ed25519 public key: counterparties must be on the curve, as wallets are. */
const FRIEND = "5fgUEyhQGy672GW9Z83Lhb2UhQU9nobHz6k4owYyaH7R";
const SOL = 1_000_000_000;
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("allowanceOf", () => {
  it("is the smaller of the user's and the site's room", () => {
    const now = Date.UTC(2026, 9, 24, 18, 0);
    expect(allowanceOf({ user: 3000, global: 150_000 }, 1000, 10_000, now)).toMatchObject({
      enabled: true,
      left: 2000,
      resetsAt: "2026-10-25T00:00:00.000Z",
    });
    expect(allowanceOf({ user: 3000, global: 150_000 }, 0, 149_500, now).left).toBe(500);
    expect(allowanceOf({ user: 3000, global: 150_000 }, 3500, 0, now).left).toBe(0);
    expect(allowanceOf({ user: 0, global: 150_000 }, 0, 0, now)).toMatchObject({ enabled: false, left: 0 });
  });
});

describe.skipIf(!dbAvailable)("readWalletFlows", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ASYL_USER_DAILY_CREDITS: 100, ASYL_DAILY_CREDITS: 150_000 }
    : (undefined as never);
  const userId = "asyl-flow-test-user";
  let calls = 0;
  const tx: ChainTx = {
    blockTime: 1_700_000_000,
    meta: { err: null, fee: 5000, preBalances: [10 * SOL, 0], postBalances: [8 * SOL - 5000, 2 * SOL] },
    transaction: { message: { accountKeys: [WALLET, FRIEND] } },
  } as ChainTx;
  const helius = {
    async getWalletTransactionsPage() {
      calls += 1;
      return { status: "ok" as const, txs: [tx], paginationToken: null };
    },
  };

  const cleanup = async () => {
    await prisma.asylFlowRead.deleteMany({ where: { wallet: WALLET } });
    await prisma.asylCreditUse.deleteMany({ where: { userId } });
  };
  beforeAll(cleanup);
  afterAll(cleanup);

  it("reads once, keeps the read for everyone, and refuses past the allowance", async () => {
    const first = await readWalletFlows(env, helius, userId, WALLET);
    expect("refused" in first).toBe(false);
    if ("refused" in first) return;
    expect(first.cached).toBe(false);
    expect(first.value.transfers).toEqual([expect.objectContaining({ counterparty: FRIEND, dir: "out" })]);
    expect(calls).toBe(1);

    const again = await readWalletFlows(env, helius, "someone-else", WALLET);
    expect(again).toMatchObject({ cached: true, credits: 0 });
    expect(calls).toBe(1);

    await prisma.asylFlowRead.deleteMany({ where: { wallet: WALLET } });
    await recordSpend(userId, 100 - FLOW_WORST + 1);
    expect(await readWalletFlows(env, helius, userId, WALLET)).toMatchObject({ refused: "allowance" });
    expect(calls).toBe(1);
    const row = await prisma.asylCreditUse.findUnique({ where: { userId_day: { userId, day: utcDay() } } });
    expect(row?.credits).toBe(100 - FLOW_WORST + 1);
  });
});

describe.skipIf(!dbAvailable)("refreshFunders", () => {
  const FRESH = addr("AsyFundFresh");
  const STALE = addr("AsyFundStale");
  const BUSY = addr("AsyFundBusy");
  const NEW = addr("AsyFundNew");
  const PAYER = addr("AsyFundPayer");
  const now = Date.UTC(2026, 9, 25, 12, 0);
  const ids = [FRESH, STALE, BUSY, NEW];
  const cleanup = () => prisma.walletFunder.deleteMany({ where: { wallet: { in: ids } } });
  beforeAll(async () => {
    await cleanup();
    const recent = new Date(now - 86_400_000);
    const old = new Date(now - 30 * 86_400_000);
    await prisma.walletFunder.createMany({
      data: [
        { wallet: FRESH, status: "found", funder: PAYER, amountSol: 1, lastActivityAt: recent },
        { wallet: STALE, status: "found", funder: PAYER, amountSol: 1, lastActivityAt: old },
        { wallet: BUSY, status: "busy" },
      ],
    });
  });
  afterAll(cleanup);

  it("asks only for missing, busy and lapsed answers, hands back what it knew, and stores what comes", async () => {
    const asked: string[][] = [];
    const known: string[] = [];
    const helius = {
      async getFundersBatch(wallets: string[], opts?: { knownOf?: ReadonlyMap<string, unknown> }) {
        asked.push([...wallets].sort());
        known.push(...(opts?.knownOf?.keys() ?? []));
        return new Map(
          wallets.map((w) => [
            w,
            {
              status: "found" as const,
              funder: PAYER,
              amountSol: 2,
              fundedAt: null,
              revived: w === STALE,
              lastActivityAt: new Date(now),
            },
          ]),
        );
      },
    };
    const res = await refreshFunders(helius, ids, now);
    expect(asked).toEqual([[STALE, BUSY, NEW].sort()]);
    expect(known).toEqual([STALE]);
    expect(res).toMatchObject({ asked: 3, found: 3 });
    expect(res.status.get(FRESH)).toBe("found");
    const stale = await prisma.walletFunder.findUnique({ where: { wallet: STALE } });
    expect(stale).toMatchObject({ amountSol: 2, revived: true, lastActivityAt: new Date(now) });
    expect(await refreshFunders(helius, ids, now)).toMatchObject({ asked: 0, found: 0 });
  });

  it("asked outright, walks a stored none again deeper, and says when the read failed", async () => {
    const NONE = addr("AsyFundNone");
    await prisma.walletFunder.deleteMany({ where: { wallet: NONE } });
    await prisma.walletFunder.create({
      data: { wallet: NONE, status: "none", lastActivityAt: new Date(now - 86_400_000) },
    });
    const calls: { wallets: string[]; walk?: number; known: string[] }[] = [];
    let answer: "found" | "failed" = "failed";
    const helius = {
      async getFundersBatch(
        wallets: string[],
        opts?: { walk?: number; knownOf?: ReadonlyMap<string, unknown> },
      ) {
        calls.push({ wallets, walk: opts?.walk, known: [...(opts?.knownOf?.keys() ?? [])] });
        return new Map(
          wallets.map((w) => [
            w,
            answer === "found"
              ? {
                  status: "found" as const,
                  funder: PAYER,
                  amountSol: 1,
                  fundedAt: null,
                  lastActivityAt: new Date(now),
                }
              : { status: "failed" as const },
          ]),
        );
      },
    };
    // The scan's bulk read leaves a "none" alone...
    expect(await refreshFunders(helius, [NONE], now)).toMatchObject({ asked: 0 });
    // ...a reader asking for it reads it again, deeper, and hears that the read failed.
    const failed = await refreshFunders(helius, [NONE], now, Infinity, true);
    expect(failed.status.get(NONE)).toBe("failed");
    expect(calls).toEqual([{ wallets: [NONE], walk: 12, known: [] }]);
    answer = "found";
    const found = await refreshFunders(helius, [NONE], now, Infinity, true);
    expect(found).toMatchObject({ asked: 1, found: 1 });
    expect(found.status.get(NONE)).toBe("found");
    expect(await prisma.walletFunder.findUnique({ where: { wallet: NONE } })).toMatchObject({
      funder: PAYER,
    });
    await prisma.walletFunder.deleteMany({ where: { wallet: NONE } });
  });
});
