import { useEffect, useState, type ReactNode } from "react";
import { type Subscription } from "../api";
import { usePolling } from "../hooks";
import { privyConfig } from "../privyBridge";
import { MIN_TRADE_SOL, useSwapCosts, type SwapCostEstimate } from "../proTrade";
import { FlameIcon } from "./Icons";

/**
 * The site's "Get $ASDFASDFA" sections (user ask 2026-10-19): buy the access token right here
 * with SOL, no TrenchScanner fee for any account, Pro Mode or not, with quick picks sized in burn
 * credits at the current rate. A pick opens the Buy $ASDFASDFA popup (BuyAsdfDialog) with its SOL
 * filled in; the popup's own quote then shows exactly what the buy gets.
 */

/** The quick picks, in burn credits. */
export const CREDIT_BUCKETS = [10, 50, 100, 250, 500, 1000] as const;

/** The reference buy the rate is read from, SOL. */
const RATE_REF_SOL = 0.1;

export interface CreditBucket {
  credits: number;
  /** The $ASDFASDFA those credits burn, whole tokens. */
  tokens: number;
  /** About what that costs in SOL at the current rate; null until the rate is read. */
  sol: number | null;
}

/** SOL rounded up to the thousandth, never under the smallest trade the API takes. */
export function roundBuySol(sol: number): number {
  return Math.max(MIN_TRADE_SOL, Math.ceil(sol * 1000) / 1000);
}

/** Each pick's tokens and SOL, from the credit price and a quote for RATE_REF_SOL. */
export function creditBuckets(
  tokensPerCredit: number | null,
  quote: Pick<SwapCostEstimate, "outAmount" | "decimals" | "refLamports"> | null,
): CreditBucket[] {
  if (!tokensPerCredit || tokensPerCredit <= 0) return [];
  let tokensPerSol: number | null = null;
  if (quote?.outAmount && typeof quote.decimals === "number" && BigInt(quote.outAmount) > 0n) {
    const refSol = Number(quote.refLamports) / 1e9;
    if (refSol > 0) tokensPerSol = Number(BigInt(quote.outAmount)) / 10 ** quote.decimals / refSol;
  }
  return CREDIT_BUCKETS.map((credits) => {
    const tokens = credits * tokensPerCredit;
    return { credits, tokens, sol: tokensPerSol ? roundBuySol(tokens / tokensPerSol) : null };
  });
}

/** The picks for `mint`, and whether buying here is open (null while asking). */
export function useCreditBuckets(mint: string | null): { open: boolean | null; buckets: CreditBucket[] } {
  const sub = usePolling<Subscription>("/subscription", 300_000);
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void privyConfig().then((c) => live && setOpen(c.accessSwap === true));
    return () => {
      live = false;
    };
  }, []);
  const quote = useSwapCosts(open && mint ? mint : null, RATE_REF_SOL);
  return { open, buckets: creditBuckets(sub.data?.price?.tokensPerCredit ?? null, quote) };
}

export const solText = (sol: number) =>
  sol.toLocaleString("en-US", { maximumFractionDigits: sol < 1 ? 3 : 2 });

const compact = (n: number) =>
  n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: n >= 1e6 ? 2 : 1 });

/** The row of credit picks; `picked` marks the one last chosen. */
export function CreditBucketPicks({
  buckets,
  onPick,
  picked = null,
  disabled = false,
}: {
  buckets: CreditBucket[];
  onPick: (b: CreditBucket) => void;
  picked?: number | null;
  disabled?: boolean;
}) {
  if (buckets.length === 0) return null;
  return (
    <div className="get-asdf-picks" role="group" aria-label="Buy by burn credits">
      {buckets.map((b) => (
        <button
          key={b.credits}
          type="button"
          className={`get-asdf-pick${picked === b.credits ? " on" : ""}`}
          aria-pressed={picked === b.credits}
          disabled={disabled}
          title={`${b.tokens.toLocaleString("en-US")} $ASDFASDFA`}
          onClick={() => onPick(b)}
        >
          <span className="get-asdf-pick-credits">
            <strong className="num">{b.credits.toLocaleString("en-US")}</strong> credits
          </span>
          <span className="get-asdf-pick-sol num">{b.sol !== null ? `≈ ${solText(b.sol)} SOL` : "–"}</span>
          <span className="get-asdf-pick-tokens num">{compact(b.tokens)} $ASDFASDFA</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A "Get $ASDFASDFA" section: what it is, the credit picks, and a button to buy any amount.
 * `onBuy` opens the site's buy, with a pick's SOL when one was chosen.
 */
export function GetAsdfCard({
  mint,
  onBuy,
  children,
}: {
  mint: string;
  onBuy: (sol?: number) => void;
  /** A line above the picks, such as what the wallet holds now. */
  children?: ReactNode;
}) {
  const { open, buckets } = useCreditBuckets(mint);
  return (
    <section className="get-asdf" aria-label="Get $ASDFASDFA">
      <header className="get-asdf-head">
        <span className="get-asdf-icon" aria-hidden="true">
          <FlameIcon size={18} />
        </span>
        <div className="get-asdf-title">
          <h4>Get $ASDFASDFA</h4>
          <p className="small muted">Buy it here with SOL from your wallet.</p>
        </div>
        <span className="get-asdf-badge">No fee</span>
      </header>
      {children && <div className="get-asdf-note small">{children}</div>}
      {open === false ? (
        <p className="small">
          Buying on the site is paused right now.{" "}
          <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer">
            Get $ASDFASDFA on Pump.fun
          </a>{" "}
          instead.
        </p>
      ) : (
        <>
          <CreditBucketPicks buckets={buckets} onPick={(b) => onBuy(b.sol ?? undefined)} disabled={!open} />
          <div className="get-asdf-foot">
            <button type="button" className="primary get-asdf-buy" disabled={!open} onClick={() => onBuy()}>
              <FlameIcon size={14} /> Buy $ASDFASDFA
            </button>
            <small className="faint">
              {buckets.length > 0
                ? "Picks are priced at the current rate. TrenchScanner takes no fee on this buy."
                : "TrenchScanner takes no fee on this buy."}
            </small>
          </div>
        </>
      )}
    </section>
  );
}
