/**
 * The dev launch score (user ask 2026-10-17, "a risk score for each dev based on the performance
 * of their launches"): how the coins a creator wallet launched went, against how every launch
 * went. The wallet risk score (riskScore.ts) is about how a wallet trades; this one is about what
 * it launches. Rebuilt hourly by the trainer's devLaunchRiskJob.ts (DevLaunchRisk, DevFunderRisk).
 *
 * A launch is a coin on the Token table with its creator known, first seen in the last
 * DEV_LAUNCH_WINDOW_DAYS and at least DEV_LAUNCH_SETTLE_MS before the rebuild. Of each launch:
 *  - whether it reached the band (Token.firstInBandAt): most launches never get to $10k;
 *  - its grade, when one is final: the coin's earliest finalized outcome row (the first moment the
 *    scan sampled it), a win being a clean 2x inside the win window and a stop a fall to the stop.
 *
 * Measured on 3,416 called coins' tapes (10-12..10-17, the creator from the tape): a coin whose dev
 * had launched before stopped 86-89% of the time against 75% for a first launch, and one whose dev
 * had earlier graded launches and no win doubled 11.2% (n=884) against 15.3%. A dev with a win
 * among a third or more of its graded launches doubled 17.2% (n=157). The learners read the
 * decision-time features (features.ts DEV_LAUNCH_FEATURES). A missing score stays null, and the
 * onset guard holds the columns out of a run until they cover the exam.
 *
 * A fresh wallet per launch would hide a farm from a per-creator record (relaunchFarm.ts), so the
 * creators one funder paid for (WalletFunder, exchanges and other hot funders aside) are pooled as
 * a family: a new creator from a funder whose other creators' coins all died reads as risky.
 */

export const DEV_LAUNCH_WINDOW_DAYS = 14;
/** A launch counts once it is this old: young enough coins haven't had their chance at the band. */
export const DEV_LAUNCH_SETTLE_MS = 60 * 60_000;
/** The outcome rows a launch's grade is read from: the scan's own samples, not users' filters. */
export const DEV_LAUNCH_GRADE_KINDS = ["event", "hourly", "second", "entry", "emission"] as const;
/**
 * A funder that paid for more creators than this in the window is a service the hot-funder rules
 * missed (an exchange not on the denylist, a payout bot), not a farm: its family is left out.
 */
export const DEV_FAMILY_MAX_CREATORS = 200;

export const DEV_LAUNCH_WEIGHTS = {
  /** Pseudo-launches at the market's rates every record is smoothed toward. */
  prior: 4,
  /**
   * Up to this many points for launches that never reached the band, against the market's rate.
   * Reaching it takes none off: every coin decided on is in the band, and a dev's other coins in
   * the band doubled no more often for it (on the 10-12..10-17 tapes).
   */
  band: 20,
  /** Up to this many points for graded launches that didn't double, against the market's rate. */
  win: 30,
  /** Up to this many points for graded launches that hit the stop, against the market's rate. */
  stop: 20,
  /**
   * The share of the win and stop weights a good record takes off, against the whole of them a bad
   * one adds: one lucky win is a thin record, and a dev with a third of its coins doubling did
   * only a little better than the market (17.2% against 15.3%).
   */
  goodSide: 0.5,
  /** Points per doubling of the launch count, up to maxSerial: a serial launcher stops more often. */
  serialPerDoubling: 5,
  maxSerial: 20,
  /** Where a dev with no record past the market's rates would sit, before the serial points. */
  base: 30,
  /** Market rates below these are treated as these, so a thin early table can't blow scores up. */
  minRate: 0.01,
} as const;

/** A dev at or above this reads as a risky launcher (the Dev card's red tag). */
export const RISKY_DEV_LAUNCH_SCORE = 70;

export interface DevLaunchStats {
  /** Launches counted. */
  launches: number;
  /** Of them, the ones that reached the band. */
  inBand: number;
  /** Of them, the ones with a final grade. */
  graded: number;
  /** Graded launches that made a clean 2x. */
  wins: number;
  /** Graded launches that hit the stop. */
  stops: number;
}

export interface DevLaunchMarket {
  bandRate: number;
  winRate: number;
  stopRate: number;
}

export const EMPTY_DEV_LAUNCH_STATS: DevLaunchStats = {
  launches: 0,
  inBand: 0,
  graded: 0,
  wins: 0,
  stops: 0,
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The market's rates over a set of launches; zeros when there are none. */
export function devLaunchMarket(totals: DevLaunchStats): DevLaunchMarket {
  return {
    bandRate: totals.launches > 0 ? totals.inBand / totals.launches : 0,
    winRate: totals.graded > 0 ? totals.wins / totals.graded : 0,
    stopRate: totals.graded > 0 ? totals.stops / totals.graded : 0,
  };
}

/**
 * The dev launch score, 0-100, higher is riskier; null without a launch on record. Each rate is
 * smoothed toward the market's by DEV_LAUNCH_WEIGHTS.prior pseudo-launches, so a dev with one dead
 * coin sits near the middle and only a longer record moves it far.
 */
export function devLaunchScore(s: DevLaunchStats, market: DevLaunchMarket): number | null {
  if (s.launches <= 0) return null;
  const w = DEV_LAUNCH_WEIGHTS;
  const mb = Math.max(w.minRate, market.bandRate);
  const mw = Math.max(w.minRate, market.winRate);
  const ms = clamp(market.stopRate, w.minRate, 1 - w.minRate);
  const band = (s.inBand + w.prior * mb) / (s.launches + w.prior);
  const win = (s.wins + w.prior * mw) / (s.graded + w.prior);
  const stop = (s.stops + w.prior * ms) / (s.graded + w.prior);
  const points =
    w.base +
    w.band * clamp(1 - band / mb, 0, 1) +
    w.win * clamp(1 - win / mw, -w.goodSide, 1) +
    w.stop * clamp((stop - ms) / (1 - ms), -w.goodSide, 1) +
    Math.min(w.maxSerial, w.serialPerDoubling * Math.log2(1 + s.launches));
  return Math.round(clamp(points, 0, 100) * 10) / 10;
}

/** a - b, field by field, never below zero (a launch recorded after the rebuild was never in a). */
export function minusLaunches(a: DevLaunchStats, b: DevLaunchStats): DevLaunchStats {
  return {
    launches: Math.max(0, a.launches - b.launches),
    inBand: Math.max(0, a.inBand - b.inBand),
    graded: Math.max(0, a.graded - b.graded),
    wins: Math.max(0, a.wins - b.wins),
    stops: Math.max(0, a.stops - b.stops),
  };
}

export function plusLaunches(a: DevLaunchStats, b: DevLaunchStats): DevLaunchStats {
  return {
    launches: a.launches + b.launches,
    inBand: a.inBand + b.inBand,
    graded: a.graded + b.graded,
    wins: a.wins + b.wins,
    stops: a.stops + b.stops,
  };
}

/** A creator's row as the scanner holds it: its record and the funder its family is keyed by. */
export interface DevLaunchEntry extends DevLaunchStats {
  /** Who paid for the creator (WalletFunder), when that funder has other creators on record. */
  funder: string | null;
}

/** A funder's family: every creator it paid for, pooled. */
export interface DevFamilyEntry extends DevLaunchStats {
  creators: number;
}

/** The decision-time reading (features.ts DEV_LAUNCH_FEATURES). */
export interface DevLaunchFeatures {
  /** The score over the creator's other launches and its funder's other creators' launches. */
  devLaunchRisk: number | null;
  /** The creator's other launches on record, and how they went. */
  devLaunchPrior: number | null;
  devLaunchPriorInBand: number | null;
  devLaunchPriorGraded: number | null;
  devLaunchPriorWins: number | null;
  /** Other creators its funder paid for, and their launches. 0 when the funder has none on record. */
  devLaunchFamilyCreators: number | null;
  devLaunchFamilyLaunches: number | null;
}

export const EMPTY_DEV_LAUNCH: DevLaunchFeatures = {
  devLaunchRisk: null,
  devLaunchPrior: null,
  devLaunchPriorInBand: null,
  devLaunchPriorGraded: null,
  devLaunchPriorWins: null,
  devLaunchFamilyCreators: null,
  devLaunchFamilyLaunches: null,
};

/**
 * One coin's reading. `entry` is the creator's row as of the rebuild (undefined when it has none:
 * no launch counted), `family` the funder's row, `own` what the rebuild counted for this coin
 * itself (taken back out: a repeat decision on a coin must not read its own band or grade), and
 * `funderOf` the creator's funder when its row doesn't name one (read since, or a new creator).
 * The family is read without the creator itself: its own record is the other half.
 */
export function coinDevLaunch(
  entry: DevLaunchEntry | undefined,
  family: DevFamilyEntry | undefined,
  own: DevLaunchStats,
  market: DevLaunchMarket,
): DevLaunchFeatures {
  const prior = entry ? minusLaunches(entry, own) : EMPTY_DEV_LAUNCH_STATS;
  // The family's pool holds this creator's launches only when the rebuild filed it under that funder.
  const inFamily = !!entry && !!family && entry.funder !== null;
  const others = family
    ? minusLaunches(family, inFamily ? entry! : EMPTY_DEV_LAUNCH_STATS)
    : EMPTY_DEV_LAUNCH_STATS;
  const otherCreators = family ? Math.max(0, family.creators - (inFamily ? 1 : 0)) : 0;
  return {
    devLaunchRisk: devLaunchScore(plusLaunches(prior, others), market),
    devLaunchPrior: prior.launches,
    devLaunchPriorInBand: prior.inBand,
    devLaunchPriorGraded: prior.graded,
    devLaunchPriorWins: prior.wins,
    devLaunchFamilyCreators: otherCreators,
    devLaunchFamilyLaunches: others.launches,
  };
}
