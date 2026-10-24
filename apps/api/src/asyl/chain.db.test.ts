// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type ChainTx, type Env } from "@trenchscanner/core";
import { allowanceOf, recordSpend, utcDay } from "./credits.js";
import { FLOW_WORST, readWalletFlows } from "./chain.js";

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
