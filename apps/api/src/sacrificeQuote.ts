import {
  BURN_CREDIT_MEMO,
  createLogger,
  burnCreditPrices,
  rawPerCredit,
  creditPots,
  creditsShort,
  describeAsdfPriceRefusal,
  sacrificeFor,
  sacrificeSettings,
  sacrificeTier,
  smoothedAsdfPerSol,
  type SacrificeMode,
  type SacrificeTier,
} from "@trenchscanner/core";
import type { ProStatus } from "./proMode.js";

const logger = createLogger("sacrifice-quote");

/**
 * The Sacrifice on one Pro trade (ASDF fee plan, Build guide step 4): the wallet's tier, what it
 * would pay for a trade worth `lamports`, and whether its burned credits cover it. The build
 * route keeps it on the build so the send takes exactly this; the fee and costs reads show it.
 *
 * "off" works nothing out. "shadow" works it all out, never refuses. "on" refuses a fee-paying
 * trade the burned credits can't cover (with the credits to top up) or the price can't price.
 */

export interface SacrificeQuote {
  mode: SacrificeMode;
  /** The free cut-off it was worked out with (SacrificeSettings.freeRank). */
  freeRank: number;
  /** Null in "off" mode: no tier is worked out. */
  tier: SacrificeTier | null;
  /** What this trade costs; null when it pays nothing or can't be priced. */
  asdfRaw: bigint | null;
  credits: number | null;
  lamports: bigint | null;
  asdfRawPerSol: bigint | null;
  /** Whole ASDF per SOL it was priced at. */
  asdfPerSol: number | null;
  /** Why the price can't be used, for a fee payer, in the trader's words. */
  priceRefusal: string | null;
  /** The burned credits the wallet has, and the whole credits it is short (0 when covered). */
  burnedCredits: number | null;
  burnedRaw: bigint | null;
  needCredits: number;
  tokensPerCredit: number | null;
}

const OFF: Omit<SacrificeQuote, "mode" | "freeRank"> = {
  tier: null,
  asdfRaw: null,
  credits: null,
  lamports: null,
  asdfRawPerSol: null,
  asdfPerSol: null,
  priceRefusal: null,
  burnedCredits: null,
  burnedRaw: null,
  needCredits: 0,
  tokensPerCredit: null,
};

export async function quoteSacrifice(input: {
  wallet: string;
  source: ProStatus["source"];
  /** An ASDF access buy by a wallet without Pro Mode: always free. */
  access: boolean;
  /** The trade's SOL value: a buy's spend, a sale's quoted SOL out. */
  lamports: bigint;
  /** The wallet's ASDF now, for the free tier's balance check (null when unreadable). */
  liveBalance: () => Promise<bigint | null>;
}): Promise<SacrificeQuote> {
  const { mode, freeRank } = await sacrificeSettings();
  if (mode === "off") return { mode, freeRank, ...OFF };
  try {
    return await quoteFor(input, mode, freeRank);
  } catch (err) {
    // Only "on" charges a trade, so only there may a failed read (the database, the price) stop
    // one; in shadow mode the trade builds without the quote rather than failing for it.
    if (mode === "on") throw err;
    logger.warn("sacrifice quote failed in shadow mode; building without it", { error: String(err) });
    return { mode, freeRank, ...OFF };
  }
}

async function quoteFor(
  input: Parameters<typeof quoteSacrifice>[0],
  mode: SacrificeMode,
  freeRank: number,
): Promise<SacrificeQuote> {
  const tier = await sacrificeTier({
    wallet: input.wallet,
    source: input.source,
    access: input.access,
    liveBalance: input.liveBalance,
  });
  const [{ tokensPerCredit }, price] = await Promise.all([
    burnCreditPrices(),
    tier.pays ? smoothedAsdfPerSol() : null,
  ]);
  const pots = await creditPots(input.wallet, undefined, tokensPerCredit);
  const base = {
    mode,
    freeRank,
    ...OFF,
    tier,
    burnedCredits: pots.burned,
    burnedRaw: pots.burnedRaw,
    tokensPerCredit,
  };
  if (!tier.pays) return base;
  if (!price || price.asdfPerSol === null)
    return { ...base, priceRefusal: describeAsdfPriceRefusal(price?.refusal ?? "few_samples") };
  const amount = sacrificeFor(input.lamports, price.asdfPerSol, tokensPerCredit);
  return {
    ...base,
    asdfRaw: amount.asdfRaw,
    credits: amount.credits,
    lamports: amount.lamports,
    asdfRawPerSol: amount.asdfRawPerSol,
    asdfPerSol: price.asdfPerSol,
    needCredits: creditsShort(amount.asdfRaw, pots.burnedRaw, tokensPerCredit),
  };
}

/** Why a build is refused for its Sacrifice ("on" mode only), or null when it may go ahead. */
export function sacrificeRefusal(q: SacrificeQuote): {
  code: 422 | 503;
  body: {
    error: string;
    needCredits?: number;
    topUp?: true;
    /** The burn that buys the missing credits: base units and the Burn Credits memo. */
    topUpRaw?: string;
    memo?: string;
    notSent: true;
  };
} | null {
  if (q.mode !== "on" || !q.tier?.pays) return null;
  if (q.priceRefusal) return { code: 503, body: { error: q.priceRefusal, notSent: true } };
  if (q.needCredits > 0)
    return {
      code: 422,
      body: {
        error: `This trade's Sacrifice is ${q.credits?.toFixed(2)} credits (0.2%, paid in burned ASDF), and you have ${(q.burnedCredits ?? 0).toFixed(2)} burned credits. Burn ASDF for ${q.needCredits} more to trade.`,
        needCredits: q.needCredits,
        topUp: true,
        topUpRaw: (BigInt(q.needCredits) * rawPerCredit(q.tokensPerCredit ?? 0)).toString(),
        memo: BURN_CREDIT_MEMO,
        notSent: true,
      },
    };
  return null;
}

/** The quote as JSON for the panel: BigInts as strings, the SOL value as lamports. */
export function sacrificeView(q: SacrificeQuote) {
  return {
    mode: q.mode,
    pays: q.tier?.pays ?? false,
    reason: q.tier?.reason ?? null,
    rank: q.tier?.rank ?? null,
    credits: q.credits,
    lamports: q.lamports?.toString() ?? null,
    asdfRaw: q.asdfRaw?.toString() ?? null,
    asdfPerSol: q.asdfPerSol,
    priceRefusal: q.priceRefusal,
    burnedCredits: q.burnedCredits,
    needCredits: q.needCredits,
    tokensPerCredit: q.tokensPerCredit,
    freeRank: q.freeRank,
    bps: 20,
  };
}
