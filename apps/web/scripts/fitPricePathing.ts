/**
 * Fits and backtests predictive price pathing (src/pricePathing.ts) from a folder of Pump.fun
 * 1-second candle pages, one JSON file per coin as
 * swap-api.pump.fun/v1/coins/<mint>/candles?interval=1s&limit=1000&currency=USD answers it:
 *
 *   npx vite-node apps/web/scripts/fitPricePathing.ts -- <candle folder> [--write]
 *
 * Coins are split 70/30 by a hash of the mint: the model is fitted on the 70 and scored on the 30
 * it never saw, against a "stays flat" guess and a "keeps its last-5s pace" guess. With --write
 * the fitted numbers replace src/pricePathingModel.ts (the report goes in its header).
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  backtest,
  coinSamples,
  fitPathModel,
  type HorizonReport,
  type SecondCandle,
} from "../src/pricePathingFit";

const HORIZONS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

const args = process.argv.slice(2).filter((a) => a !== "--");
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) throw new Error("usage: fitPricePathing.ts <candle folder> [--write]");

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

const train = [];
const test = [];
let coins = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch {
    continue;
  }
  if (!Array.isArray(body)) continue;
  // Priced as market cap, as the chart draws it (Pump.fun's one billion supply).
  const candles: SecondCandle[] = (body as { timestamp: number; close: string; volume?: string }[])
    .map((k) => ({ t: k.timestamp, c: Number(k.close) * 1e9, vol: Number(k.volume) || 0 }))
    .filter((k) => Number.isFinite(k.t) && k.c > 0)
    .sort((a, b) => a.t - b.t);
  const mint = file.replace(/\.json$/, "");
  const rows = coinSamples(mint, candles, HORIZONS);
  if (rows.length === 0) continue;
  coins++;
  (hash(mint) % 10 < 7 ? train : test).push(...rows);
}

const model = fitPathModel(train, HORIZONS);
const report = backtest(model, test);
const trainCoins = new Set(train.map((r) => r.coin)).size;
const testCoins = new Set(test.map((r) => r.coin)).size;

// The same fit on the price path alone (the first 9 features), to show what the coin's market cap
// and volume add.
const priceOnly = (rows: typeof train) => rows.map((r) => ({ ...r, features: r.features.slice(0, 9) }));
const plain = backtest(fitPathModel(priceOnly(train), HORIZONS), priceOnly(test));

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const lines = [
  `Fitted ${new Date().toISOString().slice(0, 10)} on ${trainCoins} coins (${train.length} moments), scored on ${testCoins} held-out coins (${test.length} moments); ${coins} coins had usable paths.`,
  "secs | MAE model | MAE flat | MAE pace | skill vs flat | direction hit (n) | 10-90 band coverage | band width",
  ...report.map(
    (r: HorizonReport) =>
      `${String(r.horizon).padStart(4)} | ${pct(r.maeModel)} | ${pct(r.maeFlat)} | ${pct(r.maeMomentum)} | ${(r.skill * 100).toFixed(1)}% | ${pct(r.directionHit)} (${r.directionSamples}) | ${pct(r.bandCoverage)} | ${r.bandWidthPct.toFixed(1)}%`,
  ),
];
// The direction hit to beat: always guessing the more common way.
const common = HORIZONS.map((_, hi) => {
  const moved = test.filter((r) => r.ys[hi] !== 0);
  const down = moved.filter((r) => r.ys[hi]! < 0).length;
  return Math.max(down, moved.length - down) / Math.max(1, moved.length);
});
lines.push(
  `Direction hit from always guessing the more common way: ${HORIZONS.map((h, i) => `${h}s ${pct(common[i]!)}`).join(", ")}.`,
);
lines.push(
  `Price path alone (no market cap or volume), skill vs flat by horizon: ${plain.map((r) => `${r.horizon}s ${(r.skill * 100).toFixed(1)}%`).join(", ")}.`,
);
console.log(lines.join("\n"));

if (args.includes("--write")) {
  const round = (xs: number[]) => xs.map((x) => Number(x.toPrecision(6)));
  const body = `import type { PathModel } from "./pricePathing";

/**
 * Predictive price pathing's fitted numbers, written by apps/web/scripts/fitPricePathing.ts.
 * Backtest (mean absolute error of the log change; "flat" guesses no change, "pace" keeps the last
 * 5 seconds' rate; skill above 0 beats flat):
 *
${lines.map((l) => ` * ${l}`).join("\n")}
 */
export const PATH_MODEL: PathModel = ${JSON.stringify(
    {
      version: 1,
      stepSec: model.stepSec,
      horizons: model.horizons,
      mean: round(model.mean),
      scale: round(model.scale),
      weights: model.weights.map(round),
      bandLo: round(model.bandLo),
      bandHi: round(model.bandHi),
    },
    null,
    2,
  )};
`;
  writeFileSync(new URL("../src/pricePathingModel.ts", import.meta.url), body);
  console.log("wrote src/pricePathingModel.ts");
}
