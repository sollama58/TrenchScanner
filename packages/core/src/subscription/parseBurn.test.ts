import { describe, it, expect } from "vitest";
import { parseBurnTransaction, type ParsedTransaction, type ParsedInstruction } from "./parseBurn.js";
import { SUBSCRIPTION_MINT, SUBSCRIPTION_RAW_PER_MONTH, SPL_TOKEN_PROGRAM_ID } from "./constants.js";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER = "3nQq9BsCW87d97TXJSDpbD5jBkheTqA83TZRuJosgXyZ";

function burnIx(
  over: {
    amount?: string;
    mint?: string;
    authority?: string | null;
    multisigAuthority?: string;
    type?: string;
    program?: string;
    programId?: string;
    checked?: boolean;
  } = {},
): ParsedInstruction {
  const info: Record<string, unknown> = { mint: over.mint ?? SUBSCRIPTION_MINT };
  if (over.authority !== null) info.authority = over.authority ?? WALLET;
  if (over.multisigAuthority) info.multisigAuthority = over.multisigAuthority;
  const amount = over.amount ?? SUBSCRIPTION_RAW_PER_MONTH.toString();
  if (over.checked) info.tokenAmount = { amount, decimals: 6 };
  else info.amount = amount;
  return {
    program: over.program ?? "spl-token",
    programId: over.programId ?? SPL_TOKEN_PROGRAM_ID,
    parsed: { type: over.type ?? (over.checked ? "burnChecked" : "burn"), info },
  };
}

function tx(instructions: ParsedInstruction[], over: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    slot: 442_000_000,
    blockTime: 1_800_000_000,
    transaction: { signatures: ["sig"], message: { instructions } },
    meta: { err: null, innerInstructions: null },
    ...over,
  };
}

describe("parseBurnTransaction", () => {
  it("credits a burn of exactly one month's price", () => {
    const result = parseBurnTransaction(tx([burnIx()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credit.burnerWallet).toBe(WALLET);
    expect(result.credit.months).toBe(1);
    expect(result.credit.rawAmount).toBe(SUBSCRIPTION_RAW_PER_MONTH);
  });

  it("reads burnChecked, where the amount is nested under tokenAmount", () => {
    const result = parseBurnTransaction(tx([burnIx({ checked: true })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credit.months).toBe(1);
  });

  it("credits whole multiples, so a double burn buys two months", () => {
    const result = parseBurnTransaction(
      tx([burnIx({ amount: (SUBSCRIPTION_RAW_PER_MONTH * 2n).toString() })]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credit.months).toBe(2);
  });

  it("caps the months a single burn can buy", () => {
    const huge = (SUBSCRIPTION_RAW_PER_MONTH * 5_000n).toString();
    const result = parseBurnTransaction(tx([burnIx({ amount: huge })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credit.months).toBe(12);
  });

  it("rejects one base unit short of the price", () => {
    const short = (SUBSCRIPTION_RAW_PER_MONTH - 1n).toString();
    const result = parseBurnTransaction(tx([burnIx({ amount: short })]));
    expect(result).toEqual({ ok: false, reason: "insufficient_amount" });
  });

  it("keeps u64 amounts exact rather than going through a float", () => {
    // 2^63-ish: a Number round-trip would round this and change the comparison.
    const exact = 9_223_372_036_854_775_807n;
    const result = parseBurnTransaction(tx([burnIx({ amount: exact.toString() })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credit.rawAmount).toBe(exact);
  });

  it("rejects a burn of a different token", () => {
    const result = parseBurnTransaction(
      tx([burnIx({ mint: "So11111111111111111111111111111111111111112" })]),
    );
    expect(result).toEqual({ ok: false, reason: "wrong_mint" });
  });

  it("rejects a transaction that reverted, however many burns it contains", () => {
    const failed = tx([burnIx()], {
      meta: { err: { InstructionError: [0, "Custom"] }, innerInstructions: null },
    });
    expect(parseBurnTransaction(failed)).toEqual({ ok: false, reason: "transaction_failed" });
  });

  it("rejects a lookalike burn from a program that is not SPL Token", () => {
    const impostor = burnIx({
      program: "my-token",
      programId: "Fake111111111111111111111111111111111111111",
    });
    expect(parseBurnTransaction(tx([impostor]))).toEqual({ ok: false, reason: "wrong_mint" });
  });

  it("finds a burn that only appears as an inner instruction", () => {
    const wrapped = tx([{ program: "some-router", parsed: { type: "route" } }], {
      meta: { err: null, innerInstructions: [{ instructions: [burnIx()] }] },
    });
    const result = parseBurnTransaction(wrapped);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credit.burnerWallet).toBe(WALLET);
  });

  it("sums burns by the same authority within one transaction", () => {
    const half = (SUBSCRIPTION_RAW_PER_MONTH / 2n).toString();
    const result = parseBurnTransaction(tx([burnIx({ amount: half }), burnIx({ amount: half })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credit.months).toBe(1);
  });

  it("does NOT pool two different wallets' burns into one qualifying total", () => {
    const half = (SUBSCRIPTION_RAW_PER_MONTH / 2n).toString();
    const result = parseBurnTransaction(
      tx([burnIx({ amount: half }), burnIx({ amount: half, authority: OTHER })]),
    );
    expect(result).toEqual({ ok: false, reason: "insufficient_amount" });
  });

  it("credits the authority, not a co-signer who burned nothing", () => {
    // The scenario the check exists for: OTHER pays the fee and signs, WALLET's tokens burn.
    const result = parseBurnTransaction(tx([burnIx({ authority: WALLET })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credit.burnerWallet).toBe(WALLET);
  });

  it("uses multisigAuthority when the token account is multisig-owned", () => {
    const result = parseBurnTransaction(tx([burnIx({ authority: null, multisigAuthority: OTHER })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credit.burnerWallet).toBe(OTHER);
  });

  it("rejects a burn with no authority at all", () => {
    expect(parseBurnTransaction(tx([burnIx({ authority: null })]))).toEqual({
      ok: false,
      reason: "no_authority",
    });
  });

  it("rejects a non-numeric amount rather than coercing it", () => {
    expect(parseBurnTransaction(tx([burnIx({ amount: "1e12" })]))).toEqual({
      ok: false,
      reason: "no_authority",
    });
  });

  it("reports no burn instruction when there isn't one", () => {
    const transfer: ParsedInstruction = { program: "spl-token", parsed: { type: "transfer", info: {} } };
    expect(parseBurnTransaction(tx([transfer]))).toEqual({ ok: false, reason: "no_burn_instruction" });
  });

  /**
   * Captured verbatim from mainnet transaction
   * 43WG2oAfrLiUgccnJLE3DonuEfb6Ua8D9XknWVNgk1T1xk2uJPQSyRzQbhnJ1SNrr7qVt68mVyWHPzsTdNbESvQn.
   *
   * The point of pinning a real one: every field this parser depends on - `authority`, `mint`,
   * `amount`, and the `program`/`programId` pair - is asserted against what the RPC actually
   * emits, rather than against what the docs imply it emits. It also arrived at stackHeight 4,
   * i.e. as an inner instruction, which is exactly the case a top-level-only parser drops on the
   * floor while telling the user their burn never happened.
   */
  const REAL_MAINNET_BURN: ParsedInstruction = {
    parsed: {
      info: {
        account: "9BTvwo4Ci2Qui8A8F8iqAeBjv7TGW23H9nSvTcTLzAeg",
        amount: "242158630",
        authority: "HtzGtJC4f4PqwzrVto6PmNhuQLFNeufma6kpWuAiCwjd",
        mint: "FZN7QZ8ZUUAxMPfxYEYkH3cXUASzH8EqA6B4tyCL8f1j",
      },
      type: "burn",
    },
    program: "spl-token",
    programId: SPL_TOKEN_PROGRAM_ID,
  };

  it("rejects a real mainnet burn of some other token", () => {
    const nested = tx([], {
      meta: { err: null, innerInstructions: [{ instructions: [REAL_MAINNET_BURN] }] },
    });
    expect(parseBurnTransaction(nested)).toEqual({ ok: false, reason: "wrong_mint" });
  });

  it("accepts that same real burn shape when it is our mint and clears the price", () => {
    const ours: ParsedInstruction = {
      ...REAL_MAINNET_BURN,
      parsed: {
        type: "burn",
        info: {
          ...REAL_MAINNET_BURN.parsed!.info,
          mint: SUBSCRIPTION_MINT,
          amount: SUBSCRIPTION_RAW_PER_MONTH.toString(),
        },
      },
    };
    const nested = tx([], { meta: { err: null, innerInstructions: [{ instructions: [ours] }] } });
    const result = parseBurnTransaction(nested);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credit.burnerWallet).toBe("HtzGtJC4f4PqwzrVto6PmNhuQLFNeufma6kpWuAiCwjd");
      expect(result.credit.months).toBe(1);
    }
  });

  it("tolerates a missing blockTime", () => {
    const result = parseBurnTransaction(tx([burnIx()], { blockTime: null }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credit.blockTime).toBeNull();
  });
});
