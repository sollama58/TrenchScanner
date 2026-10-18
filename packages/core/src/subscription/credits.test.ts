import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../db.js";
import {
  creditBalance,
  creditBurnCredits,
  creditPots,
  creditsFor,
  dailyFreeCredits,
  grantCredits,
  CreditGrantError,
  openLookup,
  parseCreditBurnTransaction,
  spendCredits,
} from "./credits.js";
import { BURN_CREDIT_MEMO, SPL_TOKEN_PROGRAM_ID, SUBSCRIPTION_MINT } from "./constants.js";
import type { ParsedInstruction, ParsedTransaction } from "./parseBurn.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const RUN = Date.now();
const WALLET = `CreditTestWallet${RUN}`;
const TOKENS = 10n ** 6n;

const burn = (amount: bigint): ParsedInstruction => ({
  program: "spl-token",
  programId: SPL_TOKEN_PROGRAM_ID,
  parsed: { type: "burn", info: { mint: SUBSCRIPTION_MINT, authority: WALLET, amount: amount.toString() } },
});
const memo = (text: string): ParsedInstruction => ({ program: "spl-memo", parsed: text });
const tx = (instructions: ParsedInstruction[]): ParsedTransaction => ({
  slot: 1,
  blockTime: 1_800_000_000,
  transaction: { signatures: ["sig"], message: { instructions } },
  meta: { err: null },
});

describe("creditsFor", () => {
  it("buys whole credits at the ratio and drops the remainder", () => {
    expect(creditsFor(500n * TOKENS, 500)).toBe(1);
    expect(creditsFor(1_499n * TOKENS, 500)).toBe(2);
    expect(creditsFor(499n * TOKENS, 500)).toBe(0);
    expect(creditsFor(5_000n * TOKENS, 1_000)).toBe(5);
  });
});

describe("parseCreditBurnTransaction", () => {
  it("needs the credits memo", () => {
    expect(parseCreditBurnTransaction(tx([burn(500n * TOKENS)]))).toEqual({
      ok: false,
      reason: "not_credit_burn",
    });
    const tagged = parseCreditBurnTransaction(tx([burn(500n * TOKENS), memo(BURN_CREDIT_MEMO)]), "sig");
    expect(tagged).toEqual({ ok: true, burn: { burnerWallet: WALLET, rawAmount: 500n * TOKENS } });
  });

  it("takes the amount from the chain's burn, not the memo", () => {
    const r = parseCreditBurnTransaction(tx([burn(1_000n * TOKENS), memo(BURN_CREDIT_MEMO)]));
    expect(r.ok && r.burn.rawAmount).toBe(1_000n * TOKENS);
  });

  it("refuses a co-signer's signature, a failed transaction and another mint", () => {
    expect(parseCreditBurnTransaction(tx([burn(TOKENS), memo(BURN_CREDIT_MEMO)]), "other").ok).toBe(false);
    expect(
      parseCreditBurnTransaction({ ...tx([burn(TOKENS), memo(BURN_CREDIT_MEMO)]), meta: { err: { x: 1 } } }),
    ).toEqual({ ok: false, reason: "transaction_failed" });
  });
});

describe.skipIf(!dbAvailable)("the credit ledger", () => {
  afterAll(async () => {
    await prisma.burnCreditEntry.deleteMany({ where: { wallet: WALLET } });
  });

  it("credits a burn once, however many times it is claimed", async () => {
    const sig = `CreditSig${RUN}`;
    const first = await creditBurnCredits(sig, { burnerWallet: WALLET, rawAmount: 200n * TOKENS }, "claim");
    expect(first).toEqual({ status: "credited", credits: 2, wallet: WALLET });
    const again = await Promise.all([
      creditBurnCredits(sig, { burnerWallet: WALLET, rawAmount: 200n * TOKENS }, "reconciler"),
      creditBurnCredits(sig, { burnerWallet: WALLET, rawAmount: 200n * TOKENS }, "claim"),
    ]);
    expect(again.map((o) => o.status)).toEqual(["already_credited", "already_credited"]);
    expect(await creditBalance(WALLET)).toBe(2);
  });

  it("charges a lookup once inside the re-open window, and not past the balance", async () => {
    const mint = `Mint${RUN}`;
    const results = await Promise.all([
      spendCredits(WALLET, "token", mint, 1),
      spendCredits(WALLET, "token", mint, 1),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["charged", "reopened"]);
    expect(await creditBalance(WALLET)).toBe(1);
    expect(await openLookup(WALLET, "token", mint)).not.toBeNull();
    expect(await openLookup(WALLET, "wallet", mint)).toBeNull();

    // Two different lookups racing for the last credit: one gets it.
    const race = await Promise.all([
      spendCredits(WALLET, "wallet", `A${RUN}`, 1),
      spendCredits(WALLET, "wallet", `B${RUN}`, 1),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual(["charged", "insufficient"]);
    expect(await creditBalance(WALLET)).toBe(0);
  });

  it("records an admin grant like any other row", async () => {
    expect(await grantCredits(WALLET, 3, "test")).toBe(3);
  });

  it("refuses the same grant again within seconds, and a take-back past zero", async () => {
    await expect(grantCredits(WALLET, 3, "test")).rejects.toThrow(CreditGrantError);
    await expect(grantCredits(WALLET, -4, "fix")).rejects.toThrow(/at most that many/);
    expect(await grantCredits(WALLET, -3, "fix")).toBe(0);
  });
});

describe.skipIf(!dbAvailable)("credit pots and the free daily credits", () => {
  const SUB = `CreditPotsWallet${RUN}`;
  afterAll(async () => {
    await prisma.burnCreditEntry.deleteMany({ where: { wallet: SUB } });
  });

  it("spends the free daily credits first, then granted, then burned", async () => {
    await creditBurnCredits(`PotsSig${RUN}`, { burnerWallet: SUB, rawAmount: 300n * TOKENS }, "claim");
    await grantCredits(SUB, 2, "test");
    expect(await creditPots(SUB)).toEqual({ balance: 5, granted: 2, burned: 3 });

    const first = await spendCredits(SUB, "token", `PotsMint${RUN}`, 9, true);
    expect(first).toMatchObject({ status: "charged", cost: 9, free: 9, freeLeft: 1, balance: 5 });
    // One free credit left, then the two granted: four credits draw on three pots.
    const split = await spendCredits(SUB, "wallet", `PotsW${RUN}`, 4, true);
    expect(split).toMatchObject({ status: "charged", free: 1, freeLeft: 0, balance: 2 });
    expect(await creditPots(SUB)).toEqual({ balance: 2, granted: 0, burned: 2 });
    const rows = await prisma.burnCreditEntry.findMany({
      where: { wallet: SUB, subject: `PotsW${RUN}` },
      select: { source: true, delta: true },
      orderBy: { source: "asc" },
    });
    expect(rows).toEqual([
      { source: "burned", delta: -1 },
      { source: "daily", delta: -1 },
      { source: "granted", delta: -2 },
    ]);

    // The allowance doesn't stack or reach the balance: none left today, and 2 burned can't pay 3.
    const daily = await dailyFreeCredits(SUB);
    expect(daily.left).toBe(0);
    expect(daily.nextAt).not.toBeNull();
    expect(await spendCredits(SUB, "token", `PotsMint2${RUN}`, 3, true)).toMatchObject({
      status: "insufficient",
      balance: 2,
      freeLeft: 0,
    });
    expect(await creditBalance(SUB)).toBe(2);
  });

  it("gives no free credits without a subscription", async () => {
    expect(await spendCredits(SUB, "token", `PotsMint3${RUN}`, 1, false)).toMatchObject({
      status: "charged",
      free: 0,
      freeLeft: 0,
      balance: 1,
    });
  });
});
