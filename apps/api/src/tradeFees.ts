/**
 * Fees saved (user ask 2026-10-18): what a wallet's trades through our Trade panel cost in fees,
 * and what the same trades would have cost in platform fees elsewhere, for the Portfolio page.
 *
 * Other platforms are compared on their platform fee alone, on the same trade's SOL value: every
 * one of them also pays the network (priority fee, tip, base fee), as we do, so that part is
 * shown as ours but never counted as saved. Rates checked against each platform's own fee page on
 * 2026-10-19: Fomo 0.50% (help.fomo.family, orders of 190 USDC and up; smaller orders pay more);
 * Pump.fun App 0.45% Platform Fee on every trade from 2026-10-17 (pump.fun/docs/fees, on top of the
 * protocol fees every interface pays); Axiom 0.95% net, its entry tier after cashback
 * (docs.axiom.trade, 1% gross). Terminal publishes no fee page: 0.50% is the user's figure, below the
 * ~1% third-party guides report, so it understates rather than overstates the saving.
 *
 * Our own fee is the Sacrifice (ASDF fee plan): 0% for holders above the free cut-off, 0.2% in
 * burned credits for everyone else once it is on, recorded per trade as its SOL value in
 * platformFeeLamports. A saving can go negative (the Sacrifice against a lower fee elsewhere): it is
 * reported as it is, never clamped to zero.
 *
 * Gas and priority fee (user ask 2026-10-24): the Portfolio page and the admin total can also
 * count what another platform's trade pays the network at its usual settings, 0.001 SOL gas and
 * 0.01 SOL priority fee on every buy and every sale (baseline changed from 0.002 and 0.003 on
 * 2026-10-27, user ask). It is a flat amount per trade, so it covers
 * every trade already recorded as well as new ones: each platform carries the saving both without
 * it (savedSol) and with it (savedWithNetworkSol), and the page's toggle picks one. The "with it"
 * saving subtracts what our own trades paid the network (priority fee, Sender tip and base fee,
 * networkFeeLamports), so both sides of the comparison count gas (audit TR-7, 2026-10-27).
 */

export interface PlatformFeeRate {
  id: string;
  name: string;
  /** The fee on each buy and each sale, in bps of the trade's SOL value. */
  buyBps: number;
  sellBps: number;
  /** The platform's own fee page; absent for a platform that publishes none. */
  sourceUrl?: string;
  /** No published rate to check it against (user ask 2026-10-19: shown, labelled as an estimate). */
  estimate?: boolean;
}

/** When the rates below were last checked against their sources; shown on the Portfolio page. */
export const RATES_AS_OF = "2026-10-19";

export const OTHER_PLATFORMS: readonly PlatformFeeRate[] = [
  {
    id: "fomo",
    name: "Fomo",
    buyBps: 50,
    sellBps: 50,
    sourceUrl: "https://help.fomo.family/en/articles/14436214-trading-fees-on-fomo",
  },
  { id: "pumpfun", name: "Pump.fun App", buyBps: 45, sellBps: 45, sourceUrl: "https://pump.fun/docs/fees" },
  {
    id: "terminal",
    name: "Terminal",
    buyBps: 50,
    sellBps: 50,
    estimate: true,
  },
  {
    id: "axiom",
    name: "Axiom",
    buyBps: 95,
    sellBps: 95,
    sourceUrl: "https://docs.axiom.trade/getting-started/fees/axiom-fees",
  },
];

/** What another platform's trade pays the network at its usual settings, per buy and per sale. */
export const OTHER_GAS_LAMPORTS = 1_000_000n;
export const OTHER_PRIORITY_FEE_LAMPORTS = 10_000_000n;

export interface FeeTrade {
  side: string;
  lamports: bigint;
  platformFeeLamports: bigint;
  networkFeeLamports: bigint;
}

export interface FeeSummary {
  trades: number;
  buys: number;
  sells: number;
  /** SOL traded, buys and sales together. */
  volumeSol: number;
  /** What we charged (our platform fee) and what the network took, SOL. */
  platformFeeSol: number;
  networkFeeSol: number;
  /** When the platforms' rates were last checked (RATES_AS_OF). */
  ratesAsOf: string;
  /** The gas and priority fee counted per trade elsewhere when the toggle is on, and their total. */
  otherNetwork: { gasSol: number; priorityFeeSol: number; perTradeSol: number; totalSol: number };
  /** Each other platform's fee on the same trades, and what trading here saved against it. */
  platforms: {
    id: string;
    name: string;
    buyBps: number;
    sellBps: number;
    sourceUrl?: string;
    estimate?: boolean;
    feeSol: number;
    savedSol: number;
    /** The same with the gas and priority fee above added to their side. */
    feeWithNetworkSol: number;
    savedWithNetworkSol: number;
  }[];
}

/** Confirmed trades summed by side: what feeSummary needs, from rows or from a grouped query. */
export interface FeeTotals {
  buys: number;
  sells: number;
  buyLamports: bigint;
  sellLamports: bigint;
  platformFeeLamports: bigint;
  networkFeeLamports: bigint;
}

const LAMPORTS_PER_SOL = 1e9;
const toSol = (lamports: bigint) => Number(lamports) / LAMPORTS_PER_SOL;

export function feeSummary(trades: readonly FeeTrade[], platforms = OTHER_PLATFORMS): FeeSummary {
  const totals: FeeTotals = {
    buys: 0,
    sells: 0,
    buyLamports: 0n,
    sellLamports: 0n,
    platformFeeLamports: 0n,
    networkFeeLamports: 0n,
  };
  for (const t of trades) {
    if (t.side === "buy") {
      totals.buys++;
      totals.buyLamports += t.lamports;
    } else {
      totals.sells++;
      totals.sellLamports += t.lamports;
    }
    totals.platformFeeLamports += t.platformFeeLamports;
    totals.networkFeeLamports += t.networkFeeLamports;
  }
  return feeSummaryOf(totals, platforms);
}

export function feeSummaryOf(t: FeeTotals, platforms = OTHER_PLATFORMS): FeeSummary {
  const trades = t.buys + t.sells;
  const perTrade = OTHER_GAS_LAMPORTS + OTHER_PRIORITY_FEE_LAMPORTS;
  const otherNetwork = perTrade * BigInt(trades);
  return {
    trades,
    buys: t.buys,
    sells: t.sells,
    volumeSol: toSol(t.buyLamports + t.sellLamports),
    platformFeeSol: toSol(t.platformFeeLamports),
    networkFeeSol: toSol(t.networkFeeLamports),
    ratesAsOf: RATES_AS_OF,
    otherNetwork: {
      gasSol: toSol(OTHER_GAS_LAMPORTS),
      priorityFeeSol: toSol(OTHER_PRIORITY_FEE_LAMPORTS),
      perTradeSol: toSol(perTrade),
      totalSol: toSol(otherNetwork),
    },
    platforms: platforms.map((p) => {
      const fee = (t.buyLamports * BigInt(p.buyBps) + t.sellLamports * BigInt(p.sellBps)) / 10_000n;
      return {
        ...p,
        feeSol: toSol(fee),
        savedSol: toSol(fee - t.platformFeeLamports),
        feeWithNetworkSol: toSol(fee + otherNetwork),
        savedWithNetworkSol: toSol(fee + otherNetwork - t.platformFeeLamports - t.networkFeeLamports),
      };
    }),
  };
}
