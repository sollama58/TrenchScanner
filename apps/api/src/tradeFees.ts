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
 */

export interface PlatformFeeRate {
  id: string;
  name: string;
  /** The fee on each buy and each sale, in bps of the trade's SOL value. */
  buyBps: number;
  sellBps: number;
}

export const OTHER_PLATFORMS: readonly PlatformFeeRate[] = [
  { id: "fomo", name: "Fomo", buyBps: 50, sellBps: 50 },
  { id: "pumpfun", name: "Pump.fun App", buyBps: 45, sellBps: 45 },
  { id: "terminal", name: "Terminal", buyBps: 50, sellBps: 50 },
  { id: "axiom", name: "Axiom", buyBps: 95, sellBps: 95 },
];

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
  /** Each other platform's fee on the same trades, and what trading here saved against it. */
  platforms: {
    id: string;
    name: string;
    buyBps: number;
    sellBps: number;
    feeSol: number;
    savedSol: number;
  }[];
}

const LAMPORTS_PER_SOL = 1e9;
const toSol = (lamports: bigint) => Number(lamports) / LAMPORTS_PER_SOL;

export function feeSummary(trades: readonly FeeTrade[], platforms = OTHER_PLATFORMS): FeeSummary {
  let buyLamports = 0n;
  let sellLamports = 0n;
  let platformFee = 0n;
  let networkFee = 0n;
  let buys = 0;
  let sells = 0;
  for (const t of trades) {
    if (t.side === "buy") {
      buys++;
      buyLamports += t.lamports;
    } else {
      sells++;
      sellLamports += t.lamports;
    }
    platformFee += t.platformFeeLamports;
    networkFee += t.networkFeeLamports;
  }
  return {
    trades: buys + sells,
    buys,
    sells,
    volumeSol: toSol(buyLamports + sellLamports),
    platformFeeSol: toSol(platformFee),
    networkFeeSol: toSol(networkFee),
    platforms: platforms.map((p) => {
      const fee = (buyLamports * BigInt(p.buyBps) + sellLamports * BigInt(p.sellBps)) / 10_000n;
      return { ...p, feeSol: toSol(fee), savedSol: toSol(fee - platformFee) };
    }),
  };
}
