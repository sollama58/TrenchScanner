import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_MINT, SUBSCRIPTION_RAW_PER_MONTH } from "@trenchscanner/core";
import { burnsMint, TOKEN_2022_PROGRAM_ID } from "./burnWire.js";
import {
  buildWireTransaction,
  burnInstruction,
  COMPUTE_BUDGET_PROGRAM,
  SPL_TOKEN_PROGRAM,
  toBase64,
} from "./burnWire.fixture.js";

const OWNER = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ACCOUNT = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
const OTHER_MINT = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
const BLOCKHASH = bs58.encode(Uint8Array.from({ length: 32 }, () => 9));
const AMOUNT = SUBSCRIPTION_RAW_PER_MONTH;

const computeBudget = { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: [2, 32, 78, 0, 0] };
const burn = (over: Parameters<typeof burnInstruction>[4] = {}, mint = SUBSCRIPTION_MINT) =>
  burnInstruction(ACCOUNT, mint, OWNER, AMOUNT, over);
const tx = (instructions: ReturnType<typeof burnInstruction>[], over = {}) =>
  toBase64(buildWireTransaction({ owner: OWNER, blockhash: BLOCKHASH, instructions, ...over }));

describe("burnsMint", () => {
  it("accepts the dashboard's burn: compute budget, then a burnChecked of the mint", () => {
    expect(burnsMint(tx([computeBudget, computeBudget, burn()]), SUBSCRIPTION_MINT)).toEqual({
      ok: true,
      signatures: 1,
    });
  });

  it("accepts a plain Burn, a Token-2022 burn and a v0 message", () => {
    expect(burnsMint(tx([burn({ checked: false })]), SUBSCRIPTION_MINT).ok).toBe(true);
    expect(burnsMint(tx([burn({ program: TOKEN_2022_PROGRAM_ID })]), SUBSCRIPTION_MINT).ok).toBe(true);
    expect(burnsMint(tx([burn()], { versioned: true }), SUBSCRIPTION_MINT).ok).toBe(true);
  });

  it("refuses a burn of another mint, even one that mentions ours", () => {
    const other = burn({}, OTHER_MINT);
    expect(burnsMint(tx([other]), SUBSCRIPTION_MINT)).toEqual({ ok: false, reason: "no_burn_of_mint" });
    // The mint appears among the accounts (a transfer names it), but nothing burns it.
    const transfer = {
      program: SPL_TOKEN_PROGRAM,
      accounts: [ACCOUNT, SUBSCRIPTION_MINT, OWNER],
      data: [3, 1, 0, 0, 0, 0, 0, 0, 0],
    };
    expect(burnsMint(tx([transfer]), SUBSCRIPTION_MINT)).toEqual({ ok: false, reason: "no_burn_of_mint" });
  });

  it("refuses a lookalike burn issued to a program that is not a token program", () => {
    const fake = { ...burn(), program: COMPUTE_BUDGET_PROGRAM };
    expect(burnsMint(tx([fake]), SUBSCRIPTION_MINT)).toEqual({ ok: false, reason: "no_burn_of_mint" });
  });

  it("refuses an unsigned, truncated or non-transaction payload", () => {
    expect(burnsMint(tx([burn()], { signatures: [] }), SUBSCRIPTION_MINT)).toEqual({
      ok: false,
      reason: "malformed",
    });
    const whole = Buffer.from(tx([burn()]), "base64");
    expect(burnsMint(whole.subarray(0, whole.length - 20).toString("base64"), SUBSCRIPTION_MINT)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(burnsMint(Buffer.from("hello").toString("base64"), SUBSCRIPTION_MINT).ok).toBe(false);
    expect(burnsMint("", SUBSCRIPTION_MINT).ok).toBe(false);
  });

  it("counts every signature slot, so a co-signed burn still relays", () => {
    expect(burnsMint(tx([burn()], { signatures: [7, 8] }), SUBSCRIPTION_MINT)).toEqual({
      ok: true,
      signatures: 2,
    });
  });
});
