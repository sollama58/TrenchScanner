import { describe, expect, it } from "vitest";
import { asOfText, feeText, feesCardTerms, withOtherNetwork, type FeesCardData } from "./feesCard";

const data: FeesCardData = {
  buys: 3,
  sells: 2,
  volumeSol: 6,
  platformFeeSol: 0,
  networkFeeSol: 0.002,
  platforms: [
    { name: "Fomo", buyBps: 50, sellBps: 50, savedSol: 0.03 },
    { name: "Terminal", buyBps: 50, sellBps: 50, savedSol: 0.03, estimate: true },
    { name: "Axiom", buyBps: 95, sellBps: 95, savedSol: 0.057 },
  ],
  ratesAsOf: "2026-10-19",
  solUsd: 160,
};

describe("fees share card", () => {
  it("swaps in the gas and priority fee figures when the toggle is on, and keeps older APIs' figures", () => {
    const p = { id: "fomo", name: "Fomo", buyBps: 50, sellBps: 50, feeSol: 0.03, savedSol: 0.03 };
    const net = { ...p, feeWithNetworkSol: 0.04, savedWithNetworkSol: 0.04 };
    expect(withOtherNetwork([net], true)[0]).toMatchObject({ feeSol: 0.04, savedSol: 0.04 });
    expect(withOtherNetwork([net], false)[0]).toMatchObject({ feeSol: 0.03, savedSol: 0.03 });
    expect(withOtherNetwork([p], true)[0]).toMatchObject({ savedSol: 0.03 });
  });

  it("says on the footer when gas and priority fee are counted", () => {
    expect(
      feesCardTerms({ ...data, otherNetwork: { gasSol: 0.002, priorityFeeSol: 0.003 } }).footer,
    ).toContain("incl. 0.002 SOL gas + 0.003 SOL priority fee per trade elsewhere");
  });

  it("shows fees to four decimals below 1 SOL, signed when asked", () => {
    expect(feeText(0.057, true)).toBe("+0.0570 SOL");
    expect(feeText(-0.0012, true)).toBe("-0.0012 SOL");
    expect(feeText(0, true)).toBe("0.0000 SOL");
    expect(feeText(2.5)).toBe("2.50 SOL");
  });

  it("reads the rates' date as a calendar day", () => {
    expect(asOfText("2026-10-19")).toBe("Oct 19, 2026");
    expect(asOfText(undefined)).toBeNull();
    expect(asOfText("garbage")).toBeNull();
  });

  it("carries the panel's comparison terms", () => {
    const { footer, disclaimer } = feesCardTerms(data);
    expect(footer).toBe("Estimates · rates as published Oct 19, 2026 · Terminal rate estimated");
    expect(disclaimer).toContain("Not affiliated with or endorsed by Fomo, Terminal, Axiom.");
  });

  it("drops the date when an older API sends none", () => {
    expect(feesCardTerms({ ...data, ratesAsOf: undefined }).footer).toBe(
      "Estimates · Terminal rate estimated",
    );
  });
});
