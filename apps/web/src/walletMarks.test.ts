import { describe, expect, it } from "vitest";
import {
  clampMinSol,
  DEFAULT_MARK_PREFS,
  kindsOf,
  MIN_SOL_FLOOR,
  parseMarkPrefs,
  walletMarks,
  type MarkSource,
} from "./walletMarks";

const kol: MarkSource = {
  wallet: "KoLwallet1111111111111111111111111111111111",
  tags: ["kol"],
  kol: "Cupsey",
  trades: [
    [1_000, 1, 2],
    [2_000, -1, 0.3],
    [3_000, -1, 0.1],
    [4_000, 1, null],
  ],
};
const side: MarkSource = {
  wallet: "Side111111111111111111111111111111111111111",
  tags: ["side"],
  side: { kind: "probable", kolWallet: kol.wallet, kolName: "Cupsey" },
  trades: [[1_500, 1, 0.6]],
};
const devRisky: MarkSource = {
  wallet: "Dev1111111111111111111111111111111111111111",
  tags: ["creator", "risky"],
  trades: [[500, 1, 5]],
};

describe("walletMarks", () => {
  it("defaults to every kind at 0.5 SOL, dropping smaller trades and ones of unknown size", () => {
    const out = walletMarks([kol, side, devRisky], DEFAULT_MARK_PREFS);
    expect(out.map((m) => [m.t, m.kind, m.side])).toEqual([
      [500, "dev", "buy"],
      [1_000, "kol", "buy"],
      [1_500, "probable", "buy"],
    ]);
    expect(out[1]!.text).toBe("Cupsey (KOL) bought 2.00 SOL");
  });

  it("never marks a trade under the 0.25 SOL floor, whatever the setting", () => {
    const out = walletMarks([kol], { ...DEFAULT_MARK_PREFS, minSol: 0 });
    expect(out.map((m) => m.t)).toEqual([1_000, 2_000]);
    expect(out.every((m) => m.sol >= MIN_SOL_FLOOR)).toBe(true);
  });

  it("shows only the chosen kinds, marking a wallet as its strongest shown kind", () => {
    expect(walletMarks([kol, side, devRisky], { ...DEFAULT_MARK_PREFS, kinds: ["risky"] })).toMatchObject([
      { wallet: devRisky.wallet, kind: "risky", letter: "R" },
    ]);
    expect(walletMarks([kol, side], { ...DEFAULT_MARK_PREFS, on: false })).toEqual([]);
    expect(walletMarks([kol], DEFAULT_MARK_PREFS, new Set([kol.wallet]))).toEqual([]);
  });

  it("reads a Known Side as one, not as a KOL", () => {
    expect(kindsOf({ ...kol, knownSideOf: "Main" })).toEqual(["known"]);
    expect(kindsOf(devRisky)).toEqual(["dev", "risky"]);
  });
});

describe("mark prefs", () => {
  it("clamps the size to the floor and reads bad input as the default", () => {
    expect(clampMinSol(0.1)).toBe(0.25);
    expect(clampMinSol("1.5")).toBe(1.5);
    expect(clampMinSol("abc")).toBe(0.5);
    expect(parseMarkPrefs({ on: false, kinds: ["kol", "nope"], minSol: 0 })).toEqual({
      on: false,
      kinds: ["kol"],
      minSol: 0.25,
    });
    expect(parseMarkPrefs(null)).toEqual(DEFAULT_MARK_PREFS);
  });
});
