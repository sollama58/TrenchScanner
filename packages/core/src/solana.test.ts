import { describe, expect, it } from "vitest";
import { looksLikeSolanaAddress } from "./solana.js";

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
