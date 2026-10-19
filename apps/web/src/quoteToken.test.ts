import { describe, expect, it } from "vitest";
import { quoteToken } from "./quoteToken";

const SOL = "So11111111111111111111111111111111111111112";

describe("quoteToken", () => {
  it("shows nothing for SOL or an unknown quote", () => {
    expect(quoteToken({ quoteMint: SOL, quoteSymbol: "SOL" })).toBeNull();
    expect(quoteToken({ quoteMint: null, quoteSymbol: null })).toBeNull();
    expect(quoteToken({})).toBeNull();
    expect(quoteToken({ quoteMint: "SomeOtherWrappedSol", quoteSymbol: "WSOL" })).toBeNull();
  });

  it("names the quote by its symbol", () => {
    const q = quoteToken({ quoteMint: "ASDFmint1111", quoteSymbol: "$ASDF" });
    expect(q?.label).toBe("ASDF");
    expect(q?.title).toContain("ASDFmint1111");
  });

  it("falls back to a known name, and never shows the contract address", () => {
    expect(quoteToken({ quoteMint: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB" })?.label).toBe("USD1");
    expect(quoteToken({ quoteMint: "Abcd1234567890wxyz" })).toBeNull();
    expect(quoteToken({ quoteMint: "Abcd1234567890wxyz", quoteSymbol: " " })).toBeNull();
    const ca = "DiveEYHTf3qJ1Jh9pZkD5nZtq5tZt7bJvTTr1cBCpump";
    expect(quoteToken({ quoteMint: ca, quoteSymbol: ca })).toBeNull();
  });

  it("cuts a long symbol", () => {
    expect(quoteToken({ quoteMint: "x", quoteSymbol: "VERYLONGSYMBOL" })?.label).toBe("VERYLON…");
  });
});
