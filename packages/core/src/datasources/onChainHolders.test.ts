import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { holdersFromLargestAccounts, topWalletsFromAccounts } from "./onChainHolders.js";
import { isWalletAddress, mayhemStateAddress } from "../solana.js";

/** A real wallet address: a public key on the curve. */
const wallet = (seed: number) => bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(seed)));
/** A program-derived address, off the curve like a bonding curve or pool authority. */
const PDA = mayhemStateAddress(wallet(99));
const SUPPLY = 1_000_000_000n * 1_000_000n;
const pct = (p: number) => (SUPPLY * BigInt(Math.round(p * 100))) / 10_000n;

describe("isWalletAddress", () => {
  it("tells a wallet from a program-derived address", () => {
    expect(isWalletAddress(wallet(1))).toBe(true);
    expect(isWalletAddress(PDA)).toBe(false);
    expect(isWalletAddress("not-base58-0OIl")).toBe(false);
  });
});

describe("holdersFromLargestAccounts", () => {
  it("leaves out the curve or pool, counts a wallet's accounts once, and keeps the top ten", () => {
    const accounts = [
      { owner: PDA, amount: pct(70) },
      { owner: wallet(1), amount: pct(3) },
      { owner: wallet(1), amount: pct(2) },
      ...Array.from({ length: 12 }, (_, i) => ({ owner: wallet(10 + i), amount: pct(1) })),
    ];
    const holders = holdersFromLargestAccounts(accounts, SUPPLY)!;
    expect(holders.top10HolderAddresses).toHaveLength(10);
    expect(holders.top10HolderAddresses[0]).toBe(wallet(1));
    expect(holders.top10HolderAddresses).not.toContain(PDA);
    // 5% for the first wallet plus nine at 1%.
    expect(holders.top10HolderPct).toBe(14);
    expect(holders.largestHolderPct).toBe(5);
  });

  it("has no answer without a supply, and no share when the shares can't add up", () => {
    expect(holdersFromLargestAccounts([{ owner: wallet(1), amount: 5n }], 0n)).toBeNull();
    const over = holdersFromLargestAccounts([{ owner: wallet(1), amount: SUPPLY * 2n }], SUPPLY)!;
    expect(over.top10HolderPct).toBeUndefined();
    expect(over.top10HolderAddresses).toEqual([wallet(1)]);
  });
});

describe("topWalletsFromAccounts", () => {
  it("keeps the n largest wallets past the pool, counting a wallet's accounts once", () => {
    const accounts = [
      { owner: PDA, amount: pct(70) },
      { owner: "11111111111111111111111111111111", amount: pct(9) },
      { owner: wallet(1), amount: pct(3) },
      { owner: wallet(1), amount: pct(2) },
      ...Array.from({ length: 30 }, (_, i) => ({ owner: wallet(10 + i), amount: pct(0.5) })),
    ];
    const top = topWalletsFromAccounts(accounts, SUPPLY, 25)!;
    expect(top).toHaveLength(25);
    expect(top[0]).toEqual({ owner: wallet(1), pct: 5 });
    expect(top.map((h) => h.owner)).not.toContain(PDA);
    expect(top[24]!.pct).toBe(0.5);
    expect(topWalletsFromAccounts(accounts, 0n, 25)).toBeNull();
  });

  it("lists each wallet's token accounts when the read gave them", () => {
    const top = topWalletsFromAccounts(
      [
        { owner: wallet(1), amount: pct(3), address: "acc-1" },
        { owner: wallet(1), amount: pct(2), address: "acc-2" },
        { owner: wallet(2), amount: pct(1), address: "acc-3" },
      ],
      SUPPLY,
      25,
    )!;
    expect(top).toEqual([
      { owner: wallet(1), pct: 5, accounts: ["acc-1", "acc-2"] },
      { owner: wallet(2), pct: 1, accounts: ["acc-3"] },
    ]);
  });
});
