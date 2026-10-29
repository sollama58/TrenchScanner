import { describe, expect, it } from "vitest";
import { CURVE_GAP_MS, CurveTape, decodeCurve, type CurveState } from "./curveTape.js";

const DISC = [23, 183, 248, 55, 96, 216, 172, 96];

function curveBytes(vToken: bigint, vSol: bigint, realSol: bigint, complete = false): Uint8Array {
  const data = new Uint8Array(115);
  data.set(DISC, 0);
  const view = new DataView(data.buffer);
  view.setBigUint64(8, vToken, true);
  view.setBigUint64(16, vSol, true);
  view.setBigUint64(24, 0n, true);
  view.setBigUint64(32, realSol, true);
  data[48] = complete ? 1 : 0;
  return data;
}

/** A SOL-quoted curve whose price is `price` (quote units per token unit) holding `sol` SOL. */
const state = (price: number, sol = 0): CurveState => ({
  virtualToken: 1e15,
  virtualQuote: price * 1e15,
  realQuote: sol * 1e9,
  complete: false,
  quoteIsSol: true,
});

describe("decodeCurve", () => {
  it("reads the reserves, the graduation flag and a SOL quote", () => {
    const s = decodeCurve(
      Buffer.from(curveBytes(1_000_000_000_000_000n, 30_000_000_000n, 2_500_000_000n)).toString("base64"),
    )!;
    expect(s.virtualToken).toBe(1e15);
    expect(s.virtualQuote).toBe(3e10);
    expect(s.realQuote).toBe(2.5e9);
    expect(s.complete).toBe(false);
    expect(s.quoteIsSol).toBe(true);
    expect(decodeCurve(curveBytes(1n, 1n, 0n, true))!.complete).toBe(true);
  });

  it("reads a graduated curve, emptied at migration, as complete with no price", () => {
    expect(decodeCurve(curveBytes(0n, 0n, 0n, true))).toMatchObject({ complete: true, virtualToken: 0 });
    // Empty and not graduated is no curve to price.
    expect(decodeCurve(curveBytes(0n, 0n, 0n))).toBeNull();
    const tape = new CurveTape();
    tape.record("m", 1_000, state(3e-5), "read");
    tape.record("m", 2_000, { ...state(0), virtualToken: 0, virtualQuote: 0, complete: true }, "read");
    expect(tape.isComplete("m")).toBe(true);
  });

  it("is null for anything that isn't a curve", () => {
    const bad = curveBytes(1n, 1n, 0n);
    bad[0] = 0;
    expect(decodeCurve(bad)).toBeNull();
    expect(decodeCurve(new Uint8Array(10))).toBeNull();
  });
});

describe("CurveTape", () => {
  it("answers returns, net SOL and the high from a streamed tape opened by a read", () => {
    const tape = new CurveTape();
    const t0 = 1_000_000;
    tape.record("m", t0, state(1, 10), "read");
    // A change every 5 s for two minutes, the price climbing 1% a step, 0.5 SOL in each time.
    for (let i = 1; i <= 24; i++) {
      tape.record("m", t0 + i * 5_000, state(1.01 ** i, 10 + i * 0.5), "stream");
      tape.confirmStreamed("m", t0, t0 + i * 5_000);
    }
    const now = t0 + 120_000;
    const f = tape.features("m", now);
    expect(f.curveCoveredSec).toBe(120);
    expect(f.curveRet10sPct).toBeCloseTo((1.01 ** 2 - 1) * 100, 1);
    expect(f.curveRet1mPct).toBeCloseTo((1.01 ** 12 - 1) * 100, 1);
    expect(f.curveRet3mPct).toBeNull();
    expect(f.curveNetSol1m).toBe(6);
    expect(f.curveFromHighPct).toBe(0);
    expect(f.curveSecSinceHigh).toBe(0);
    expect(f.curveChanges1m).toBe(12);
    expect(f.curveVolatility1m).toBeCloseTo(0, 3);
  });

  it("can't open a tape from the stream, and goes blank after a hole", () => {
    const tape = new CurveTape();
    tape.record("m", 0, state(1), "stream");
    expect(tape.features("m", 0).curveCoveredSec).toBeNull();
    tape.record("m", 0, state(1), "read");
    expect(tape.features("m", CURVE_GAP_MS + 1).curveRet10sPct).toBeNull();
    // A reading after the hole starts the cover again from it.
    tape.record("m", 60_000, state(2), "read");
    const f = tape.features("m", 60_000);
    expect(f.curveCoveredSec).toBe(0);
    expect(f.curveRet10sPct).toBeNull();
  });

  it("carries a tape the unbroken stream confirms however long after the last confirmation", () => {
    // A slow worker round confirmed past CURVE_GAP_MS and was refused, so the next stream update
    // wiped the tape (chart audit 2026-10-29, D4). The stream since 0 vouches for every moment.
    const tape = new CurveTape();
    tape.record("m", 0, state(1), "read");
    tape.confirmStreamed("m", 0, CURVE_GAP_MS + 5_000);
    tape.record("m", CURVE_GAP_MS + 6_000, state(2), "stream");
    expect(tape.features("m", CURVE_GAP_MS + 6_000).curveCoveredSec).toBe((CURVE_GAP_MS + 6_000) / 1_000);
    // A stream whose run began after the tape was last current vouches for nothing.
    tape.confirmStreamed("m", CURVE_GAP_MS + 7_000, CURVE_GAP_MS + 30_000);
    expect(tape.features("m", 2 * CURVE_GAP_MS + 7_000).curveCoveredSec).toBeNull();
  });

  it("ends the stream's run at the last moment it was shown live, so a later read opens a new cover", () => {
    // A silent subscription was confirmed every round and saved as quiet (chart audit D3).
    const tape = new CurveTape();
    tape.record("m", 0, state(1), "read");
    tape.confirmStreamed("m", 0, 10_000);
    tape.record("m", 10_000, state(2), "stream");
    tape.confirmStreamed("m", 0, 130_000);
    expect(tape.ticksAfter("m", -1)).toMatchObject({ confirmedAt: 130_000, streamFrom: 0 });
    tape.endStreamRun("m", 20_000);
    expect(tape.ticksAfter("m", -1)).toMatchObject({ confirmedAt: 20_000, streamFrom: null });
    // Never back past the newest change it holds.
    tape.endStreamRun("m", 5_000);
    expect(tape.ticksAfter("m", -1)?.confirmedAt).toBe(10_000);
    // The check's read, past the gap: the price is known from there, the move into it is not.
    tape.record("m", 125_000, state(3), "read");
    expect(tape.ticksAfter("m", -1)).toMatchObject({
      coveredFrom: 125_000,
      confirmedAt: 125_000,
      streamFrom: null,
      ticks: [{ at: 125_000, price: 3, realQuote: 0 }],
    });
    tape.endStreamRun("never", 0);
    expect(tape.ticksAfter("never", -1)).toBeNull();
  });

  it("ignores a read older than the newest change, and leaves changes unknown on a polled minute", () => {
    const tape = new CurveTape();
    tape.record("m", 0, state(1), "read");
    for (let t = 5_000; t <= 70_000; t += 5_000) tape.record("m", t, state(1 + t / 1e6), "read");
    tape.record("m", 71_000, state(5), "stream");
    tape.record("m", 70_500, state(9), "read");
    const f = tape.features("m", 71_000);
    expect(f.curveRet1mPct).toBeCloseTo(((5 - 1.01) / 1.01) * 100, 1);
    expect(f.curveChanges1m).toBeNull();
    expect(f.curveNetSol1m).toBe(0);
  });

  it("answers the prints between two moments, and nothing for a mint it never saw", () => {
    const tape = new CurveTape();
    expect(tape.labelPrices("m", 0, 60_000)).toEqual({
      basis: null,
      changes: [],
      quoteIsSol: false,
      coveredMs: 0,
    });
    tape.record("m", 0, state(1), "read");
    tape.record("m", 10_000, state(2.2), "stream");
    tape.record("m", 20_000, state(1.05), "stream");
    expect(tape.labelPrices("m", 0, 60_000)).toEqual({
      basis: { at: 0, price: 1 },
      changes: [
        { at: 10_000, price: 2.2 },
        { at: 20_000, price: 1.05 },
      ],
      quoteIsSol: true,
      coveredMs: 20_000,
    });
    expect(tape.labelPrices("other", 0, 60_000)).toEqual({
      basis: null,
      changes: [],
      quoteIsSol: false,
      coveredMs: 0,
    });
    // A hole drops the old cover. The price before it is not a basis for the new one.
    tape.record("m", 20_000 + 60_000, state(4), "read");
    expect(tape.labelPrices("m", 0, 20_000)).toEqual({
      basis: null,
      changes: [],
      quoteIsSol: false,
      coveredMs: 0,
    });
  });

  it("counts a print at the window's end once, and a print at the start as the basis", () => {
    const tape = new CurveTape();
    tape.record("m", 1_000, state(1), "read");
    tape.record("m", 2_000, state(2), "stream");
    tape.record("m", 3_000, state(3), "stream");
    // afterMs is exclusive, untilMs inclusive: the print at 2_000 is the basis, the one at 3_000
    // is a change. The next window opens at 3_000, so that print is not counted twice.
    expect(tape.labelPrices("m", 2_000, 3_000)).toEqual({
      basis: { at: 2_000, price: 2 },
      changes: [{ at: 3_000, price: 3 }],
      quoteIsSol: true,
      coveredMs: 1_000,
    });
    expect(tape.labelPrices("m", 3_000, 4_000)).toEqual({
      basis: { at: 3_000, price: 3 },
      changes: [],
      quoteIsSol: true,
      coveredMs: 0,
    });
    // A print from before the open is not folded in as a move.
    expect(tape.labelPrices("m", 2_500, 3_000).changes.map((c) => c.at)).toEqual([3_000]);
  });
});
