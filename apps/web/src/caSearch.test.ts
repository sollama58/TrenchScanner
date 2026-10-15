import { describe, expect, it } from "vitest";
import { cardMatchesCa, parseCaQuery } from "./caSearch";

const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const PUMP = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFpump";

describe("parseCaQuery", () => {
  it("reads nothing from an empty or too-short box", () => {
    expect(parseCaQuery("")).toEqual({ kind: "none" });
    expect(parseCaQuery("   ")).toEqual({ kind: "none" });
    expect(parseCaQuery("7G")).toEqual({ kind: "none" });
  });

  it("takes a whole address, trimmed", () => {
    expect(parseCaQuery(`  ${MINT}\n`)).toEqual({ kind: "full", mint: MINT });
  });

  it("takes part of an address as a partial match", () => {
    expect(parseCaQuery("pump")).toEqual({ kind: "partial", text: "pump" });
  });

  it("finds the address in a pasted token link", () => {
    expect(parseCaQuery(`https://pump.fun/coin/${PUMP}`)).toEqual({
      kind: "full",
      mint: PUMP,
    });
    expect(parseCaQuery(`https://solscan.io/token/${MINT}?cluster=mainnet`)).toEqual({
      kind: "full",
      mint: MINT,
    });
  });

  it("reads a link with no address in it as text", () => {
    expect(parseCaQuery("https://example.com/")).toEqual({ kind: "partial", text: "https://example.com/" });
  });
});

describe("cardMatchesCa", () => {
  it("matches any part of the address, in any case", () => {
    const card = { token: { mintAddress: MINT } } as Parameters<typeof cardMatchesCa>[0];
    expect(cardMatchesCa(card, "w2HR")).toBe(true);
    expect(cardMatchesCa(card, "7gci")).toBe(true);
    expect(cardMatchesCa(card, "zzzz")).toBe(false);
  });
});
