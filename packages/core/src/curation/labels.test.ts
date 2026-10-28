import { describe, expect, it } from "vitest";
import {
  applyPriceTick,
  isWin,
  computeOutcomeLabels,
  CURRENT_LABEL_RULE,
  DEXSCREENER_ANCHOR_LABEL_RULE,
  decisionAnchor,
  dollarTicksFromCurve,
  FINE_TICK_SMOOTHING_MS,
  smoothedCurvePrices,
  SMOOTHED_FINE_TICK_LABEL_RULE,
  freshQuoteMcapUsd,
  dollarScaleBasis,
  fineTickWindow,
  FINE_TICK_LABEL_RULE,
  FRESH_ANCHOR_LABEL_RULE,
  nextCurveTapeCoveredMs,
  trainsOnLabelRule,
  CANDIDATE_WATCH_WINDOW_MINUTES,
  isCurrentLabelRule,
  initialOutcomeAggregates,
  LABEL_LOG2_CAP,
  RUN_WEIGHT_PER_DOUBLING,
  runDoublings,
  runWeight,
  tenXVerdict,
  type OutcomeAggregates,
} from "./labels.js";

const T0 = new Date("2026-08-27T12:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** Replays a sequence of (price, minute) ticks the way the watcher does: fold, merge, repeat. */
function replay(anchorPrice: number, ticks: [price: number, minute: number][]): OutcomeAggregates {
  let agg = initialOutcomeAggregates(anchorPrice, T0);
  for (const [price, minute] of ticks) {
    agg = { ...agg, ...applyPriceTick(agg, price, minutes(minute)) };
  }
  return agg;
}

describe("the 10x-within-an-hour tier", () => {
  it("credits a clean winner that reaches 10x after the label window but inside the hour", () => {
    const atClose = replay(1, [
      [2.2, 5],
      [3, 25],
    ]);
    const labels = computeOutcomeLabels(atClose);
    // At the 30-minute close the hour is still open.
    expect(labels.hit4xIn1h).toBe(false);
    expect(labels.hit10xIn1h).toBeNull();
    const later = { ...atClose, ...applyPriceTick(atClose, 10.5, minutes(50)) };
    expect(tenXVerdict(later, true, true)).toBe(true);
    // The label window's own aggregates don't move past 30 minutes.
    expect(later.peak1hPriceUsd).toBe(3);
  });

  it("refuses a 10x reached only after the hour, or after the stop", () => {
    const late = replay(1, [
      [2.2, 5],
      [10.5, 61],
    ]);
    expect(tenXVerdict(late, true, true)).toBe(false);
    const stopped = replay(1, [
      [2.2, 5],
      [0.4, 40],
      [12, 50],
    ]);
    expect(tenXVerdict(stopped, true, true)).toBe(false);
    // The stop settles it at once: nothing later in the hour can count, so it needn't wait.
    expect(tenXVerdict(stopped, true, false)).toBe(false);
    const running = replay(1, [
      [2.2, 5],
      [3, 40],
    ]);
    expect(tenXVerdict(running, true, false)).toBeNull();
  });

  it("settles a non-winner as no at the close, and leaves untracked rows unknown", () => {
    const dud = replay(1, [[1.5, 5]]);
    expect(computeOutcomeLabels(dud).hit10xIn1h).toBe(false);
    expect(
      tenXVerdict({ anchorPriceUsd: 1, peakBeforeStop60mPriceUsd: null, stopped60mAt: null }, true, true),
    ).toBeNull();
  });
});

describe("candidate outcome labels", () => {
  it("labels a token that never ran as a zero, with its drawdown recorded", () => {
    const agg = replay(1, [
      [1.1, 5],
      [0.7, 20],
      [0.9, 45],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(false);
    expect(labels.disqualified).toBe(false);
    expect(labels.labelValue).toBe(0);
    expect(labels.peak1hReturnPct).toBeCloseTo(10);
    expect(labels.maxDrawdown1hPct).toBeCloseTo(-30);
  });

  it("labels a fast, clean 2x as a win worth its doublings", () => {
    const agg = replay(1, [
      [1.2, 3],
      [0.9, 6],
      [2.5, 12],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.disqualified).toBe(false);
    expect(labels.labelValue).toBeCloseTo(Math.log2(2.5));
    expect(agg.hit2xAt).toEqual(minutes(12));
  });

  it("a 2x that arrives after 15 minutes is a miss", () => {
    // The bar is 2x within 15 minutes - a 20-minute double is too late, even inside the window.
    const agg = replay(1, [
      [1.4, 10],
      [2.5, 20],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(agg.hit2xAt).toEqual(minutes(20));
    expect(labels.hit2xIn15m).toBe(false);
    expect(labels.hit2xIn1h).toBe(false);
    expect(labels.disqualified).toBe(false);
    expect(labels.labelValue).toBe(0);
  });

  it("grades a win on how far it ran by 30 minutes, so the 4x goal is worth double a 2x", () => {
    const stalled = computeOutcomeLabels(replay(1, [[2.1, 10]]));
    const ranOn = computeOutcomeLabels(
      replay(1, [
        [2.1, 10],
        [4.0, 25], // kept running after the win landed - the goal
      ]),
    );
    expect(stalled.hit4xIn1h).toBe(false);
    expect(ranOn.hit4xIn1h).toBe(true);
    expect(stalled.labelValue).toBeCloseTo(Math.log2(2.1));
    expect(ranOn.labelValue).toBeCloseTo(2); // log2(4)
    expect(ranOn.labelValue).toBeGreaterThan(stalled.labelValue);
  });

  it("credits a 4x at minute 30 after a 15-minute double as the goal it is", () => {
    const agg = replay(1, [
      [2.2, 14],
      [4.0, 30],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit4xIn1h).toBe(true);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.labelValue).toBeCloseTo(2);
  });

  it("does not count a 4x that lands after 30 minutes", () => {
    const agg = replay(1, [
      [2.2, 10],
      [3.0, 28],
      [4.5, 40], // past the goal window: the run peak, not the goal
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.hit4xIn1h).toBe(false);
    expect(labels.labelValue).toBeCloseTo(Math.log2(3));
    expect(agg.peak24hPriceUsd).toBe(4.5);
  });

  it("does not count a 4x by a call that doubled too late", () => {
    const labels = computeOutcomeLabels(replay(1, [[4.0, 20]]));
    expect(labels.hit2xIn1h).toBe(false);
    expect(labels.hit4xIn1h).toBe(false);
    expect(labels.labelValue).toBe(0);
  });

  it("does not count a 4x that first breached the stop", () => {
    const labels = computeOutcomeLabels(
      replay(1, [
        [0.45, 5],
        [4.5, 12],
      ]),
    );
    expect(labels.disqualified).toBe(true);
    expect(labels.hit4xIn1h).toBe(false);
  });

  it("does not count a 4x reached only after a post-2x fall through the stop", () => {
    // Doubled cleanly, then fell to 45% of the alert price (a stop-out), then ran to 4.2x. Still a 2x
    // win - the double came first - but the 4x is not one a buyer holding to the stop traded.
    const labels = computeOutcomeLabels(
      replay(1, [
        [2.1, 10],
        [0.45, 20],
        [4.2, 28],
      ]),
    );
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.disqualified).toBe(false);
    expect(labels.hit4xIn1h).toBe(false);
    expect(labels.labelValue).toBeCloseTo(Math.log2(2.1));
    expect(labels.peak1hReturnPct).toBeCloseTo(320); // the raw peak is still recorded
  });

  it("falls back to the window peak on rows that predate the stop-aware peak", () => {
    const agg = { ...replay(1, [[4.5, 12]]), peakBeforeStopPriceUsd: null, stoppedAt: null };
    expect(computeOutcomeLabels(agg).hit4xIn1h).toBe(true);
  });

  it("disqualifies a 2x that first traded at or below half the anchor", () => {
    const agg = replay(1, [
      [0.4, 8],
      [2.2, 14],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.disqualified).toBe(true);
    expect(labels.labelValue).toBe(0);
  });

  it("disqualifies a fast 2x that first traded at or below half the anchor", () => {
    const agg = replay(1, [
      [0.45, 4],
      [2.2, 9],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.disqualified).toBe(true);
    expect(labels.labelValue).toBe(0);
  });

  it("does NOT disqualify for a crash that happens after the 2x", () => {
    const agg = replay(1, [
      [2.0, 5],
      [0.3, 30],
    ]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.disqualified).toBe(false);
    // The pre-2x trough froze at the anchor; the post-2x crash only shows in maxDrawdown1hPct.
    expect(agg.lowBefore2xPriceUsd).toBe(1);
    expect(labels.maxDrawdown1hPct).toBeCloseTo(-70);
    expect(labels.labelValue).toBeCloseTo(1);
  });

  it("caps the label so one moonshot cannot outweigh a month of 2xs", () => {
    const agg = replay(1, [[150, 10]]);
    expect(computeOutcomeLabels(agg).labelValue).toBe(LABEL_LOG2_CAP);
  });

  it("counts a first tick that is already a 2x as a clean win", () => {
    const agg = replay(1, [[2.1, 1]]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.disqualified).toBe(false);
  });

  // The two lines every graded hit rate rests on (full audit 2026-10-27, CH-4): a near miss on
  // either side of the 2x bar and of the -50% stop, with literal prices, so a change to
  // WIN_MULTIPLE or DISQUALIFYING_DRAWDOWN_FRACTION fails here rather than passing every label test.
  it("does not count a peak just under 2x as a win, and counts exactly 2x", () => {
    const miss = computeOutcomeLabels(replay(1, [[1.99, 5]]));
    expect(miss.hit2xIn15m).toBe(false);
    expect(miss.hit2xIn1h).toBe(false);
    expect(miss.labelValue).toBe(0);
    const near = computeOutcomeLabels(replay(1, [[1.8, 5]]));
    expect(near.hit2xIn15m).toBe(false);
    const hit = computeOutcomeLabels(replay(1, [[2, 5]]));
    expect(hit.hit2xIn15m).toBe(true);
    expect(hit.labelValue).toBeCloseTo(1);
  });

  it("stops a row that trades at exactly -50% before its 2x, and not one that holds just above", () => {
    const held = computeOutcomeLabels(
      replay(1, [
        [0.51, 3],
        [2, 8],
      ]),
    );
    expect(held.hit2xIn15m).toBe(true);
    expect(held.disqualified).toBe(false);
    expect(held.labelValue).toBeCloseTo(1);
    const stopped = computeOutcomeLabels(
      replay(1, [
        [0.5, 3],
        [2, 8],
      ]),
    );
    expect(stopped.hit2xIn15m).toBe(true);
    expect(stopped.disqualified).toBe(true);
    expect(stopped.labelValue).toBe(0);
  });

  it("treats the exact win-window boundary as inside the window", () => {
    const labels = computeOutcomeLabels(replay(1, [[2.0, 15]]));
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.labelValue).toBeCloseTo(1);
  });

  it("treats the exact 30-minute boundary as inside the goal window", () => {
    const labels = computeOutcomeLabels(
      replay(1, [
        [2.0, 5],
        [4.0, 30],
      ]),
    );
    expect(labels.hit4xIn1h).toBe(true);
  });

  it("keeps ticks after the goal window out of the window aggregates but in the run peak", () => {
    const agg = replay(1, [
      [1.5, 10],
      [3.0, 45], // past the goal window
    ]);
    expect(agg.peak1hPriceUsd).toBe(1.5);
    expect(agg.hit2xAt).toBeNull();
    expect(agg.peak24hPriceUsd).toBe(3.0);
    expect(agg.peak24hAt).toEqual(minutes(45));
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn1h).toBe(false);
    expect(labels.hit4xIn1h).toBe(false);
  });

  it("ignores zero, negative, and non-finite prices", () => {
    const agg = replay(1, [
      [0, 5],
      [-3, 10],
      [Number.NaN, 15],
    ]);
    expect(agg.peak1hPriceUsd).toBe(1);
    expect(agg.low1hPriceUsd).toBe(1);
  });

  it("labels a row that never got a single tick as a zero with no drawdown claim", () => {
    const labels = computeOutcomeLabels(initialOutcomeAggregates(1, T0));
    expect(labels.labelValue).toBe(0);
    expect(labels.peak1hReturnPct).toBe(0);
    expect(labels.maxDrawdown1hPct).toBe(0);
  });
});

describe("alert-price grading", () => {
  /** Ticks are [price, seconds after the alert]. */
  function replayAt(anchorPrice: number, ticks: [price: number, second: number][]): OutcomeAggregates {
    let agg = initialOutcomeAggregates(anchorPrice, T0);
    for (const [price, second] of ticks) {
      agg = { ...agg, ...applyPriceTick(agg, price, new Date(T0.getTime() + second * 1000)) };
    }
    return agg;
  }

  it("grades from the alert price, with no delay and no slippage", () => {
    const agg = replayAt(1, [
      [2.0, 30], // a 2x of the alert price inside the first half-minute counts
      [1.5, 600],
    ]);
    expect(agg.entryAt).toEqual(new Date(T0.getTime() + 30_000));
    expect(agg.signalPriceUsd).toBe(1);
    expect(agg.anchorPriceUsd).toBe(1);
    expect(computeOutcomeLabels(agg).hit2xIn1h).toBe(true);
  });

  it("keeps the base at the alert price when the first price is higher or lower", () => {
    expect(replayAt(1, [[1.3, 65]]).anchorPriceUsd).toBe(1);
    expect(replayAt(1, [[0.8, 61]]).anchorPriceUsd).toBe(1);
    // 2.4 is a 2x of the alert price even though the first price seen was 1.3.
    const won = computeOutcomeLabels(
      replayAt(1, [
        [1.3, 65],
        [2.4, 900],
      ]),
    );
    expect(won.hit2xIn1h).toBe(true);
  });

  it("never opens a row after the win window - an outage's first price is not an entry", () => {
    const agg = replayAt(1, [[1.1, 16 * 60]]);
    expect(agg.entryAt).toBeNull();
    expect(agg.anchorPriceUsd).toBe(1);
  });

  it("measures the stop from the alert price", () => {
    const labels = computeOutcomeLabels(
      replayAt(1, [
        [1.0, 61],
        [0.5, 300], // half the alert price
        [2.5, 840],
      ]),
    );
    expect(labels.disqualified).toBe(true);
    expect(labels.labelValue).toBe(0);
  });
});

describe("runWeight", () => {
  it("weighs a loss and a plain 2x as one row, and a winner more the further it ran", () => {
    expect(runWeight({ labelValue: 0, runPeakMultiple: 50 })).toBe(1);
    expect(runWeight({ labelValue: 1 })).toBe(1);
    expect(runWeight({ labelValue: 2 })).toBeCloseTo(1 + RUN_WEIGHT_PER_DOUBLING, 9);
    // The 24h run peak counts when it is further than the label window's peak.
    expect(runWeight({ labelValue: 1, runPeakMultiple: 16 })).toBeCloseTo(1 + 3 * RUN_WEIGHT_PER_DOUBLING, 9);
    expect(runWeight({ labelValue: 2, runPeakMultiple: 1.5 })).toBeCloseTo(1 + RUN_WEIGHT_PER_DOUBLING, 9);
  });

  it("caps the run at the label cap and turns off at 0", () => {
    expect(runDoublings({ labelValue: 1, runPeakMultiple: 10_000 })).toBeCloseTo(LABEL_LOG2_CAP, 9);
    expect(runWeight({ labelValue: 3, runPeakMultiple: 64 }, 0)).toBe(1);
  });

  it("counts a late runner's run for the score but not for the weight, like the live record", () => {
    // Held above the stop and doubled after the window: run size 2 doublings (a 4x)...
    expect(runDoublings({ labelValue: 0, survived: true, runPeakMultiple: 4 })).toBeCloseTo(2, 9);
    // ...but it is a loss under the label, so it trains at one row.
    expect(runWeight({ labelValue: 0, runPeakMultiple: 4 })).toBe(1);
    // Fell through the stop first, or never reached 2x: nothing.
    expect(runDoublings({ labelValue: 0, survived: false, runPeakMultiple: 4 })).toBe(0);
    expect(runDoublings({ labelValue: 0, runPeakMultiple: 4 })).toBe(0);
    expect(runDoublings({ labelValue: 0, survived: true, runPeakMultiple: 1.9 })).toBe(0);
  });
});

describe("the 24-hour run peak", () => {
  it("takes ticks up to 24 hours after the anchor and none after", () => {
    const agg = replay(1, [
      [2.2, 5],
      [6, 24 * 60],
      [9, 24 * 60 + 30],
    ]);
    expect(agg.peak24hPriceUsd).toBe(6);
    expect(agg.peak24hAt).toEqual(minutes(24 * 60));
  });
});

describe("decisionAnchor", () => {
  const fresh = (priceUsd: number) => ({ priceUsd, marketCapUsd: priceUsd * 1e9, fetchedAt: new Date() });

  it("anchors on the fresh quote under rule 4, the current rule", () => {
    const a = decisionAnchor({ priceUsd: 0.0001, marketCapUsd: 100_000, freshQuote: fresh(0.00014) });
    expect(a).toMatchObject({ priceUsd: 0.00014, labelRule: FRESH_ANCHOR_LABEL_RULE });
    expect(a.marketCapUsd).toBeCloseTo(140_000, 6);
    expect(isCurrentLabelRule(a)).toBe(true);
  });

  it("puts the quote's price on DexScreener's supply, not Jupiter's post-burn one", () => {
    // DexScreener: $0.0001 at $100k (1B). Jupiter: $0.00014, with an mcap on 0.914B ($127,960).
    const a = decisionAnchor({
      priceUsd: 0.0001,
      marketCapUsd: 100_000,
      freshQuote: { priceUsd: 0.00014, marketCapUsd: 127_960 },
    });
    expect(a.marketCapUsd).toBeCloseTo(140_000, 6);
    expect(freshQuoteMcapUsd({ priceUsd: 0.0001, marketCapUsd: 100_000 })).toBeNull();
  });

  it("falls back to the scan price without a quote, or with one too far off to be a move", () => {
    const scan = { priceUsd: 0.0001, marketCapUsd: 100_000 };
    const expected = { ...scan, labelRule: DEXSCREENER_ANCHOR_LABEL_RULE };
    expect(CURRENT_LABEL_RULE).toBe(FRESH_ANCHOR_LABEL_RULE);
    expect(isCurrentLabelRule(expected)).toBe(false);
    expect(decisionAnchor(scan)).toEqual(expected);
    expect(decisionAnchor({ ...scan, freshQuote: fresh(0.0006) })).toEqual(expected);
    expect(decisionAnchor({ ...scan, freshQuote: fresh(0.00001) })).toEqual(expected);
    // Inclusive at 5x and at 1/5, the same bound decisionMcapUsd uses.
    expect(decisionAnchor({ ...scan, freshQuote: fresh(0.0005) }).labelRule).toBe(FRESH_ANCHOR_LABEL_RULE);
    expect(decisionAnchor({ ...scan, freshQuote: fresh(0.00002) }).labelRule).toBe(FRESH_ANCHOR_LABEL_RULE);
    expect(decisionAnchor({ ...scan, freshQuote: fresh(0.00051) })).toEqual(expected);
    expect(decisionAnchor({ ...scan, freshQuote: fresh(0.000019) })).toEqual(expected);
  });
});

describe("sub-minute curve prints", () => {
  const fold = (
    anchor: number,
    curve: { basis: { at: number; price: number } | null; changes: { at: number; price: number }[] },
    minute: { priceUsd: number; at: Date },
    later: [price: number, minute: number][] = [],
  ) => {
    let agg = initialOutcomeAggregates(anchor, T0);
    const ticks = [
      ...dollarTicksFromCurve(curve, minute),
      minute,
      ...later.map(([price, m]) => ({ priceUsd: price, at: minutes(m) })),
    ];
    ticks.sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const tick of ticks) agg = { ...agg, ...applyPriceTick(agg, tick.priceUsd, tick.at) };
    return agg;
  };

  it("counts a wick to 2x and back inside one minute as a win", () => {
    const minute = new Date(T0.getTime() + 60_000);
    // Curve units are 10x the dollar price. The minute print is back at $1.05.
    const curve = {
      basis: { at: T0.getTime(), price: 10 },
      changes: [
        { at: T0.getTime() + 20_000, price: 22 },
        { at: T0.getTime() + 40_000, price: 10.5 },
      ],
    };
    const withTape = fold(1, curve, { priceUsd: 1.05, at: minute });
    const labels = computeOutcomeLabels(withTape);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.hit2xIn15m).toBe(true);
    expect(labels.disqualified).toBe(false);
    expect(labels.labelValue).toBeCloseTo(Math.log2(2.2));
    expect(withTape.hit2xAt).toEqual(new Date(T0.getTime() + 20_000));
    // The minute sample alone never saw the wick.
    const minuteOnly = fold(1, { basis: null, changes: [] }, { priceUsd: 1.05, at: minute });
    expect(computeOutcomeLabels(minuteOnly).hit2xIn1h).toBe(false);
    expect(computeOutcomeLabels(minuteOnly).labelValue).toBe(0);
    expect(FINE_TICK_LABEL_RULE).toBe(5);
    expect(CURRENT_LABEL_RULE).toBe(4);
  });

  it("disqualifies a wick through the stop that recovers before a later 2x", () => {
    const minute = new Date(T0.getTime() + 60_000);
    const curve = {
      basis: { at: T0.getTime(), price: 10 },
      changes: [
        { at: T0.getTime() + 10_000, price: 4 },
        { at: T0.getTime() + 30_000, price: 10 },
      ],
    };
    const agg = fold(1, curve, { priceUsd: 1, at: minute }, [[2.4, 10]]);
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn1h).toBe(true);
    expect(labels.disqualified).toBe(true);
    expect(labels.hit4xIn1h).toBe(false);
    expect(labels.labelValue).toBe(0);
    expect(agg.lowBefore2xPriceUsd).toBeCloseTo(0.4);
  });

  it("leaves a coin with no curve tape on the minute sample", () => {
    const minute = new Date(T0.getTime() + 60_000);
    expect(dollarTicksFromCurve({ basis: null, changes: [] }, { priceUsd: 2.2, at: minute })).toEqual([]);
    const agg = fold(1, { basis: null, changes: [] }, { priceUsd: 2.2, at: minute });
    expect(computeOutcomeLabels(agg)).toMatchObject({
      hit2xIn1h: true,
      disqualified: false,
      labelValue: Math.log2(2.2),
    });
    // A tape that starts after the dollar print cannot invent a scale.
    expect(
      dollarTicksFromCurve(
        { basis: null, changes: [{ at: minute.getTime() + 5_000, price: 30 }] },
        { priceUsd: 1, at: minute },
      ),
    ).toEqual([]);
  });

  it("prices SOL-quoted curve prints from SOL/USD, not from a lagged dollar print", () => {
    // Pump.fun coins are 6 decimals. The tape's price is lamports per raw token, so
    // USD = curvePrice * solUsd * 1e6 / 1e9. At $150 SOL that factor is 0.15.
    const solUsd = 150;
    const perUnit = (solUsd * 1e6) / 1e9;
    const atDollar = (usd: number) => usd / perUnit;
    const minute = new Date(T0.getTime() + 60_000);
    // The coin halved across the 15s DexScreener's lag can be off (the watcher restamps by
    // 45s; the feed runs 45-60s behind). The dollar print is still $1. The curve in force
    // at that timestamp has already halved.
    const curve = {
      basis: { at: minute.getTime(), price: atDollar(0.5) },
      changes: [
        { at: T0.getTime() + 20_000, price: atDollar(1) },
        { at: T0.getTime() + 50_000, price: atDollar(0.5) },
      ],
    };
    const lagged = dollarTicksFromCurve(curve, { priceUsd: 1, at: minute });
    // Dividing the lagged $1 by the dumped curve doubles every earlier print: a fake 2x,
    // and the stop prints as $1.
    expect(lagged.find((t) => t.at.getTime() === T0.getTime() + 20_000)!.priceUsd).toBeCloseTo(2);
    expect(lagged.find((t) => t.at.getTime() === T0.getTime() + 50_000)!.priceUsd).toBeCloseTo(1);
    const honest = dollarTicksFromCurve(curve, { priceUsd: 1, at: minute }, perUnit);
    expect(honest.find((t) => t.at.getTime() === T0.getTime() + 20_000)!.priceUsd).toBeCloseTo(1);
    expect(honest.find((t) => t.at.getTime() === T0.getTime() + 50_000)!.priceUsd).toBeCloseTo(0.5);

    // The other way: a 2x that sticks across that same 15s is flattened back to the lagged print.
    const pumped = {
      basis: { at: minute.getTime(), price: atDollar(2) },
      changes: [
        { at: T0.getTime() + 20_000, price: atDollar(1) },
        { at: T0.getTime() + 50_000, price: atDollar(2) },
      ],
    };
    const hidden = dollarTicksFromCurve(pumped, { priceUsd: 1, at: minute });
    expect(hidden.find((t) => t.at.getTime() === T0.getTime() + 50_000)!.priceUsd).toBeCloseTo(1);
    const seen = dollarTicksFromCurve(pumped, { priceUsd: 1, at: minute }, perUnit);
    expect(seen.find((t) => t.at.getTime() === T0.getTime() + 50_000)!.priceUsd).toBeCloseTo(2);

    let agg = initialOutcomeAggregates(1, T0);
    for (const tick of [...honest, { priceUsd: 1, at: minute }].sort(
      (a, b) => a.at.getTime() - b.at.getTime(),
    )) {
      agg = { ...agg, ...applyPriceTick(agg, tick.priceUsd, tick.at) };
    }
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn1h).toBe(false);
    expect(labels.disqualified).toBe(false);
    expect(agg.low1hPriceUsd).toBeCloseTo(0.5);
  });
});

describe("curve label window and scale basis", () => {
  it("clamps folded prints to the label window and drops an empty slice", () => {
    const anchor = T0;
    const windowMs = CANDIDATE_WATCH_WINDOW_MINUTES * 60_000;
    const open = fineTickWindow(anchor, anchor.getTime(), anchor.getTime() + 60_000);
    expect(open).toEqual({ afterMs: anchor.getTime(), untilMs: anchor.getTime() + 60_000 });
    // A sweep past the window still stops at the window's end.
    const late = fineTickWindow(anchor, anchor.getTime() + 10 * 60_000, anchor.getTime() + 40 * 60_000);
    expect(late?.untilMs).toBe(anchor.getTime() + windowMs);
    // Already graded through the window: nothing left to fold.
    expect(fineTickWindow(anchor, anchor.getTime() + windowMs, anchor.getTime() + 40 * 60_000)).toBeNull();
    // Before the anchor is not a slice.
    expect(fineTickWindow(anchor, anchor.getTime() - 1_000, anchor.getTime() - 1)).toBeNull();
  });

  it("scales from the last dollar print, not from a curve tick stored as lastPriceUsd", () => {
    const dollarAt = new Date(T0.getTime() + 60_000);
    const curveAt = new Date(T0.getTime() + 70_000);
    // This sweep has a dollar print. It wins, whatever lastPriceUsd holds.
    expect(
      dollarScaleBasis({
        candidate: { at: dollarAt, priceUsd: 1.1 },
        lastDollarAt: null,
        lastDollarPriceUsd: null,
        labelRule: 5,
        lastPriceUsd: 4,
        lastCheckedAt: curveAt,
      }),
    ).toEqual({ at: dollarAt, priceUsd: 1.1 });
    // No new dollar print. Rule 5's lastPriceUsd may be a scaled curve tick, so it is not the basis.
    expect(
      dollarScaleBasis({
        candidate: null,
        lastDollarAt: dollarAt,
        lastDollarPriceUsd: 1.1,
        labelRule: 5,
        lastPriceUsd: 4,
        lastCheckedAt: curveAt,
      }),
    ).toEqual({ at: dollarAt, priceUsd: 1.1 });
    expect(
      dollarScaleBasis({
        candidate: null,
        lastDollarAt: null,
        lastDollarPriceUsd: null,
        labelRule: 5,
        lastPriceUsd: 4,
        lastCheckedAt: curveAt,
      }),
    ).toBeNull();
    // A rule-4 row has never written a curve tick into lastPriceUsd.
    expect(
      dollarScaleBasis({
        candidate: null,
        lastDollarAt: null,
        lastDollarPriceUsd: null,
        labelRule: 4,
        lastPriceUsd: 1.1,
        lastCheckedAt: dollarAt,
      }),
    ).toEqual({ at: dollarAt, priceUsd: 1.1 });
  });

  it("keeps rule 5 in the fit unless the flag says otherwise, and caps tape coverage", () => {
    expect(trainsOnLabelRule(4)).toBe(true);
    expect(trainsOnLabelRule(5)).toBe(true);
    expect(trainsOnLabelRule(5, true)).toBe(false);
    expect(trainsOnLabelRule(4, true)).toBe(true);
    expect(trainsOnLabelRule(3, true)).toBe(false);
    const windowMs = CANDIDATE_WATCH_WINDOW_MINUTES * 60_000;
    expect(nextCurveTapeCoveredMs(null, 10_000)).toBe(10_000);
    expect(nextCurveTapeCoveredMs(windowMs - 1_000, 5_000)).toBe(windowMs);
    expect(nextCurveTapeCoveredMs(12_000, 0)).toBe(12_000);
  });
});

describe("5-second smoothing of curve prints (rule 6)", () => {
  const at = (s: number) => T0.getTime() + s * 1_000;
  const minute = new Date(at(60));
  /** Folds smoothed curve ticks and the minute print, the way the watcher does. */
  const fold = (curve: {
    basis: { at: number; price: number } | null;
    changes: { at: number; price: number }[];
  }) => {
    let agg = initialOutcomeAggregates(1, T0);
    const ticks = [
      ...dollarTicksFromCurve(curve, { priceUsd: 1, at: minute }, 0.1, { afterMs: at(0), untilMs: at(60) }),
      { priceUsd: 1, at: minute },
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const t of ticks) agg = { ...agg, ...applyPriceTick(agg, t.priceUsd, t.at) };
    return agg;
  };

  it("averages the step price over the 5 seconds before each turn", () => {
    // $1 (curve 10), one trade to $3 for a second, back to $1.
    const points = smoothedCurvePrices(
      {
        basis: { at: at(0), price: 10 },
        changes: [
          { at: at(20), price: 30 },
          { at: at(21), price: 10 },
        ],
      },
      at(0),
      at(60),
    );
    expect(FINE_TICK_SMOOTHING_MS).toBe(5_000);
    expect(points.map((p) => [p.at - T0.getTime(), p.price])).toEqual([
      [5_000, 10],
      [20_000, 10],
      [21_000, 14],
      [25_000, 14],
      [26_000, 10],
    ]);
  });

  it("does not count a one-trade wick to 3x as a 2x or as the peak", () => {
    const agg = fold({
      basis: { at: at(0), price: 10 },
      changes: [
        { at: at(20), price: 30 },
        { at: at(21), price: 10 },
      ],
    });
    const labels = computeOutcomeLabels(agg);
    expect(agg.hit2xAt).toBeNull();
    expect(labels.hit2xIn1h).toBe(false);
    expect(labels.labelValue).toBe(0);
    // The high is the 5-second average's: $1.40, not the $3 print.
    expect(agg.peak1hPriceUsd).toBeCloseTo(1.4);
    expect(agg.peak24hPriceUsd).toBeCloseTo(1.4);
    expect(labels.peak1hReturnPct).toBeCloseTo(40);
  });

  it("does not stop a call on a one-trade dip through 50%", () => {
    const agg = fold({
      basis: { at: at(0), price: 10 },
      changes: [
        { at: at(10), price: 3 },
        { at: at(11), price: 10 },
      ],
    });
    expect(agg.lowBefore2xPriceUsd).toBeCloseTo(0.86);
    expect(agg.stoppedAt).toBeNull();
    expect(computeOutcomeLabels({ ...agg, hit2xAt: minutes(5) }).disqualified).toBe(false);
  });

  it("counts a 2x that holds, timed when the 5-second average gets there", () => {
    const agg = fold({
      basis: { at: at(0), price: 10 },
      changes: [
        { at: at(20), price: 22 },
        { at: at(40), price: 10 },
      ],
    });
    const labels = computeOutcomeLabels(agg);
    expect(labels.hit2xIn1h).toBe(true);
    expect(agg.hit2xAt).toEqual(new Date(at(25)));
    expect(labels.labelValue).toBeCloseTo(Math.log2(2.2));
    expect(SMOOTHED_FINE_TICK_LABEL_RULE).toBe(6);
  });

  it("averages across the start of the slice from the history before it", () => {
    // A sweep that starts at 22s still sees the 3x from 20-21s in its first average.
    const points = smoothedCurvePrices(
      {
        basis: { at: at(0), price: 10 },
        changes: [
          { at: at(20), price: 30 },
          { at: at(21), price: 10 },
        ],
      },
      at(22),
      at(60),
    );
    expect(points[0]).toEqual({ at: at(25), price: 14 });
  });

  it("keeps fine-tick rows out of the fit only when asked, rule 6 with rule 5", () => {
    expect(trainsOnLabelRule(6)).toBe(true);
    expect(trainsOnLabelRule(6, true)).toBe(false);
    expect(trainsOnLabelRule(5, true)).toBe(false);
    expect(trainsOnLabelRule(4, true)).toBe(true);
  });
});

describe("isWin", () => {
  it("counts a clean 2x or better as a win and a 0 label as a loss", () => {
    expect(isWin({ labelValue: 1 })).toBe(true);
    expect(isWin({ labelValue: Math.log2(1.01) })).toBe(true);
    expect(isWin({ labelValue: 0 })).toBe(false);
    expect(isWin({ labelValue: Number.NaN })).toBe(false);
  });
});
