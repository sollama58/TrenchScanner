import { describe, expect, it } from "vitest";
import { parseSearch, searchParam } from "./caSearch";

const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const PUMP = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFpump";

describe("parseSearch", () => {
  it("reads nothing from an empty or one-letter box", () => {
    expect(parseSearch("")).toEqual({ kind: "none" });
    expect(parseSearch("   ")).toEqual({ kind: "none" });
    expect(parseSearch("w")).toEqual({ kind: "none" });
    expect(parseSearch("$w")).toEqual({ kind: "none" });
  });

  it("takes a whole address, trimmed", () => {
    expect(parseSearch(`  ${MINT}\n`)).toEqual({ kind: "mint", mint: MINT });
  });

  it("finds the address in a pasted token link", () => {
    expect(parseSearch(`https://pump.fun/coin/${PUMP}`)).toEqual({ kind: "mint", mint: PUMP });
    expect(parseSearch(`https://solscan.io/token/${MINT}?cluster=mainnet`)).toEqual({
      kind: "mint",
      mint: MINT,
    });
  });

  it("takes a ticker without its $, a name, or part of an address as text", () => {
    expect(parseSearch("$WIF")).toEqual({ kind: "text", text: "WIF" });
    expect(parseSearch("dog wif hat")).toEqual({ kind: "text", text: "dog wif hat" });
    expect(parseSearch("pump")).toEqual({ kind: "text", text: "pump" });
  });
});

describe("searchParam", () => {
  it("asks the API for the address or the text", () => {
    expect(searchParam({ kind: "none" })).toBe("");
    expect(searchParam({ kind: "mint", mint: MINT })).toBe(`mint=${MINT}`);
    expect(searchParam({ kind: "text", text: "dog & cat" })).toBe("q=dog%20%26%20cat");
  });
});
