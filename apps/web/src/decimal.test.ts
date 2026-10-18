import { describe, expect, it } from "vitest";
import { decimalText, decimalUnits, parseAmounts, parseDecimal, parseDecimalList } from "./decimal";

describe("typed decimals", () => {
  it("reads a dot or a comma as the decimal separator", () => {
    expect(parseDecimal("0.5")).toBe(0.5);
    expect(parseDecimal("0,5")).toBe(0.5);
    expect(parseDecimal(" 12,25 ")).toBe(12.25);
    expect(parseDecimal(",5")).toBe(0.5);
    expect(parseDecimal("2,")).toBe(2);
    expect(decimalText("0,0001")).toBe("0.0001");
  });
  it("refuses grouping, signs, exponents and text rather than guess", () => {
    for (const bad of ["", " ", ".", ",", "1,000.5", "1.000,5", "1,000,000", "-1", "+1", "1e3", "abc", "1 5"])
      expect(parseDecimal(bad)).toBeNull();
  });
  it("turns a typed amount into exact base units", () => {
    expect(decimalUnits("0,1", 9)).toBe(100_000_000n);
    expect(decimalUnits("0.000000001", 9)).toBe(1n);
    expect(decimalUnits("0.0000000001", 9)).toBeNull();
    expect(decimalUnits("1234567", 9, 6)).toBeNull();
    // 0.1 + 0.2 style float error can't creep in.
    expect(decimalUnits("0,3", 9)).toBe(300_000_000n);
  });
  it("splits lists on spaces and semicolons, and on commas that can't be decimals", () => {
    expect(parseDecimalList("0.1, 0.25 0.5")).toEqual([0.1, 0.25, 0.5]);
    expect(parseDecimalList("0,1; 0,25 0,5")).toEqual([0.1, 0.25, 0.5]);
    expect(parseDecimalList("0.1,0.5,1")).toEqual([0.1, 0.5, 1]);
    expect(parseDecimalList("25,50,100")).toEqual([25, 50, 100]);
    expect(parseDecimalList("1,5")).toEqual([1.5]);
    expect(parseAmounts("0,05 0,1 0,5", 100, 5, 0.01)).toEqual([0.05, 0.1, 0.5]);
  });
});
