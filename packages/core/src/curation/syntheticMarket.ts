import type { TrainingRow } from "./trainer.js";

/**
 * A synthetic trench market for comparing curator model families offline (tests and
 * scripts/compareLearners.ts), while production hit-rate data is out of reach. It is NOT
 * evidence about the real market: it encodes assumptions about how outcomes depend on features,
 * and any learner comparison on it only shows which family copes better with THOSE assumptions.
 * Its use is checking the machinery (does the boosted model find interactions the linear one
 * can't, does it overfit pure noise, how many alerts does a 75% cutoff leave) before live data
 * can settle the real question.
 *
 * Every token gets a few decision ("event") rows and some hourly background rows. The chance a
 * row wins depends on its features through the chosen `truth`:
 *  - "linear": a sum of one-feature effects on the log-odds - the logistic model's home turf.
 *  - "interactions": thresholds and interactions of the kind trench lore describes - buy
 *    pressure only helps when the top 10 isn't sniper-heavy, a market-cap sweet spot, late
 *    chasers (already up a lot this hour) losing, a 5m volume burst mattering only on young
 *    tokens - plus a slow regime drift in how much socials matter.
 *  - "noise": outcomes independent of features (a learner that "finds" signal here overfits).
 */
export type SyntheticTruth = "linear" | "interactions" | "noise";

export interface SyntheticMarketOptions {
  tokens: number;
  days: number;
  truth: SyntheticTruth;
  seed?: number;
  /** Shifts every row's log-odds - tunes the base win rate. */
  baseLogOdds?: number;
  /** Multiplies the feature-driven part of the log-odds: 1 = default, higher = more predictable. */
  signalScale?: number;
}

const T0 = new Date("2026-07-01T00:00:00Z").getTime();

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function syntheticMarket(opts: SyntheticMarketOptions): TrainingRow[] {
  const rand = prng(opts.seed ?? 7);
  const base = opts.baseLogOdds ?? -3.2;
  const spanMs = opts.days * 86_400_000;
  const rows: TrainingRow[] = [];

  for (let t = 0; t < opts.tokens; t++) {
    const tokenId = `tok${t}`;
    const launchMs = T0 + rand() * spanMs;
    // Token-level traits shared by all its rows (rows of one token are correlated, as in life).
    const quality = gaussian(rand);
    const sniperPct = Math.max(0, Math.min(100, 25 + 20 * gaussian(rand) - 8 * quality));
    const hasTwitter = rand() < 0.55 ? 1 : 0;
    const hasTelegram = rand() < 0.35 ? 1 : 0;
    const devPct = Math.max(0, 4 + 4 * gaussian(rand));
    const rowCount = 1 + Math.floor(rand() * 4);

    for (let r = 0; r < rowCount; r++) {
      const ageMinutes = 5 + r * 60 + rand() * 50;
      const anchorMs = launchMs + ageMinutes * 60_000;
      if (anchorMs > T0 + spanMs) break;
      const mcapUsd = Math.exp(Math.log(10_000) + rand() * Math.log(80) + 0.3 * quality);
      const buyRatio1h = Math.max(0.2, Math.min(0.9, 0.55 + 0.08 * gaussian(rand) + 0.03 * quality));
      const priceChange1hPct = Math.exp(1.5 * gaussian(rand) + 3) - 20;
      const priceChange5mPct = 15 * gaussian(rand) + 3 * quality;
      const volume5mUsd = mcapUsd * Math.exp(gaussian(rand) - 2.5 + 0.3 * quality);
      const volume1hUsd = volume5mUsd * (6 + 6 * rand());
      const holderCount = Math.round(
        Math.exp(4 + 0.6 * gaussian(rand) + 0.4 * quality + Math.log1p(ageMinutes) / 3),
      );
      const liquidityUsd = mcapUsd * (0.15 + 0.1 * rand());
      const riskScore = Math.max(0, Math.min(100, 30 + 20 * gaussian(rand)));
      const top10HolderPct = Math.max(10, Math.min(90, 35 + 12 * gaussian(rand)));
      const time = (anchorMs - T0) / spanMs; // 0..1 through the window

      let z = 0;
      if (opts.truth === "linear") {
        z += 0.8 * quality + 6 * (buyRatio1h - 0.55) - 0.02 * (sniperPct - 25) + 0.4 * hasTwitter;
      } else if (opts.truth === "interactions") {
        const lowSnipers = sniperPct < 30;
        z += 0.6 * quality;
        z += lowSnipers ? 14 * Math.max(0, buyRatio1h - 0.55) : -1.0 * Math.max(0, buyRatio1h - 0.55) * 10;
        const logM = Math.log10(mcapUsd);
        z += -1.6 * (logM - 4.6) ** 2; // sweet spot around $40k
        if (priceChange1hPct > 150) z -= 1.5; // late chasers
        if (ageMinutes < 90 && volume5mUsd / mcapUsd > 0.12) z += 1.4; // early volume burst
        z += (time < 0.5 ? 0.9 : -0.3) * hasTwitter; // socials mattered, then stopped
      }
      const pWin = sigmoid(base + (opts.signalScale ?? 1) * z);
      const won = rand() < pWin;
      // Winners run further when quality is higher: log2 of the peak multiple, >= 1 (a 2x).
      const labelValue = won ? 1 + Math.max(0, 1.2 * rand() + 0.3 * quality + 0.4 * gaussian(rand)) : 0;

      const features: Record<string, number | null> = {
        mcapUsd,
        liquidityUsd,
        liquidityToMcapRatio: liquidityUsd / mcapUsd,
        volume5mUsd,
        volume1hUsd,
        volume5mToMcapRatio: volume5mUsd / mcapUsd,
        volume1hToMcapRatio: volume1hUsd / mcapUsd,
        buyRatio1h,
        priceChange5mPct,
        priceChange1hPct,
        holderCount,
        top10HolderPct,
        devWalletPct: devPct,
        riskScore: rand() < 0.1 ? null : riskScore,
        // Wallet checks are budgeted - a share of rows never get them.
        freshTop10WalletPct: rand() < 0.25 ? null : sniperPct,
        emptyTop10WalletPct: rand() < 0.25 ? null : Math.max(0, sniperPct / 2 + 5 * gaussian(rand)),
        ageMinutes,
        graduated: mcapUsd > 69_000 ? 1 : 0,
        hasTwitter,
        hasTelegram,
        hasWebsite: rand() < 0.3 ? 1 : 0,
        // Pure noise columns, so a learner has something to overfit to.
        narrativeTagCount: Math.floor(rand() * 4),
        scoreNarrative: rand() * 100,
      };
      rows.push({
        tokenId,
        anchorAt: new Date(anchorMs),
        features,
        labelValue,
        anchorPriceUsd: mcapUsd / 1e9,
        anchorMcapUsd: mcapUsd,
        sampleKind: r === 0 || rand() < 0.3 ? "event" : "hourly",
      });
    }
  }
  return rows.sort((a, b) => a.anchorAt.getTime() - b.anchorAt.getTime());
}
