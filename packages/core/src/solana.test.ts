import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { looksLikeSolanaAddress, mayhemStateAddress } from "./solana.js";

describe("looksLikeSolanaAddress", () => {
  it("accepts real-shaped mint/wallet addresses", () => {
    expect(looksLikeSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true); // USDC
    expect(looksLikeSolanaAddress("So11111111111111111111111111111111111111112")).toBe(true); // wSOL
  });

  it("rejects strings that are too short or too long", () => {
    expect(looksLikeSolanaAddress("abc")).toBe(false);
    expect(looksLikeSolanaAddress("a".repeat(45))).toBe(false);
  });

  it("rejects characters outside the base58 alphabet", () => {
    expect(looksLikeSolanaAddress("0PjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false); // leading 0
    expect(looksLikeSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1O")).toBe(false); // trailing O
    expect(looksLikeSolanaAddress("../../etc/passwd")).toBe(false);
    expect(looksLikeSolanaAddress("https://evil.example/x")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(looksLikeSolanaAddress("")).toBe(false);
  });
});

describe("mayhemStateAddress", () => {
  // Pinned against @solana/web3.js's PublicKey.findProgramAddressSync. The three cases below
  // resolve at bumps 255, 254 and 253 respectively - the non-255 ones matter, because they only
  // come out right if the ed25519 on-curve rejection actually works rather than the first
  // candidate happening to be valid.
  const CASES: [mint: string, expectedPda: string][] = [
    ["GuYxhafeew241DThgKquTXEEBpt8FRPdRq6xfstdpump", "HmT6rHQvnpx8nk6WqtZbzeThLmSwhsZQUJeVoEdWJWTr"],
    ["3jNd8LdRvzCKBdWevmaqdDfqGk7op8GqkXnb3qVBpump", "7tFMXj7Wmen4ZCRfCU5Bjafo7fKEvM669Ea554EwrFD5"],
    ["So11111111111111111111111111111111111111112", "G4B72nNj73YuTvHThfwfmJuXtzcmFAbv396cxtUVzeN6"],
  ];

  it.each(CASES)("derives the canonical PDA for %s", (mint, expected) => {
    expect(mayhemStateAddress(mint)).toBe(expected);
  });

  it("is deterministic", () => {
    const mint = CASES[0]![0];
    expect(mayhemStateAddress(mint)).toBe(mayhemStateAddress(mint));
  });

  it("derives a different address per mint", () => {
    expect(mayhemStateAddress(CASES[0]![0])).not.toBe(mayhemStateAddress(CASES[1]![0]));
  });

  it("never returns an address that is itself a valid on-curve public key", () => {
    // A PDA has no private key by construction; if this ever produced an on-curve point the
    // account could be signed for, which would defeat the point of using one as a marker.
    for (const [mint] of CASES) {
      expect(() => ed25519.ExtendedPoint.fromHex(bs58.decode(mayhemStateAddress(mint)))).toThrow();
    }
  });
});
