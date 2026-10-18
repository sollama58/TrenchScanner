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
});
