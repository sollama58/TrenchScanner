import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { privyConfig } from "../privyBridge";
import { MIN_TRADE_SOL } from "../proTrade";
import { FlameIcon } from "./Icons";

/**
 * The site's "Get $ASDFASDFA" sections (user ask 2026-10-19): buy the access token right here
 * with SOL, no TrenchScanner fee for any account, Pro Mode or not, with quick picks sized in burn
 * credits, each quoted by the API to land at least that many credits at the current price (in the
 * credit reload areas only). A pick opens the Buy $ASDFASDFA popup (BuyAsdfDialog) with its SOL
 * filled in; the popup's own quote then shows exactly what the buy gets.
 */

/** The API's credit picks (GET /pro/trade/credit-picks). */
export interface CreditPicksResponse {
  mint: string;
  decimals: number;
  tokensPerCredit: number;
  picks: { credits: number; units: string; lamports: string | null }[];
}

export interface CreditBucket {
  credits: number;
  /** The $ASDFASDFA those credits burn, whole tokens. */
  tokens: number;
  /** The SOL that buys at least that much now (quoted per pick); null without a quote. */
  sol: number | null;
  /** The quote was under the smallest trade, so the buy is the minimum and lands more credits. */
  atMinimum: boolean;
}

/** SOL rounded up to the thousandth, never under the smallest trade the API takes. */
export function roundBuySol(sol: number): number {
  return Math.max(MIN_TRADE_SOL, Math.ceil(sol * 1000) / 1000);
}

/** Each pick's tokens and SOL from the API's quotes. */
export function creditBuckets(r: CreditPicksResponse | null): CreditBucket[] {
  if (!r || r.tokensPerCredit <= 0) return [];
  return r.picks.map((p) => {
    const exact = p.lamports !== null ? Number(p.lamports) / 1e9 : null;
    return {
      credits: p.credits,
      tokens: Number(BigInt(p.units)) / 10 ** r.decimals,
      sol: exact !== null ? roundBuySol(exact) : null,
      atMinimum: exact !== null && exact < MIN_TRADE_SOL,
    };
  });
}

/** The picks, and whether buying here is open (null while asking). Picks are only read when wanted. */
export function useCreditBuckets(wanted = true): { open: boolean | null; buckets: CreditBucket[] } {
  const [open, setOpen] = useState<boolean | null>(null);
  const [picks, setPicks] = useState<CreditPicksResponse | null>(null);
  useEffect(() => {
    let live = true;
    void privyConfig().then((c) => live && setOpen(c.accessSwap === true));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!open || !wanted) return;
    let live = true;
    const load = () =>
      api<CreditPicksResponse>("/pro/trade/credit-picks")
        .then((r) => live && setPicks(r))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, wanted]);
  return { open, buckets: creditBuckets(picks) };
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
          <span className="get-asdf-pick-sol num">
            {b.sol === null ? "–" : b.atMinimum ? `${solText(b.sol)} SOL min` : `≈ ${solText(b.sol)} SOL`}
          </span>
          <span className="get-asdf-pick-tokens num">{compact(b.tokens)} $ASDFASDFA</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A "Get $ASDFASDFA" section: what it is, the credit picks (`picks`, the credit reload areas
 * only), and a button to buy any amount. `onBuy` opens the site's buy, with a pick's SOL when one
 * was chosen.
 */
export function GetAsdfCard({
  mint,
  onBuy,
  picks = false,
  children,
}: {
  mint: string;
  onBuy: (sol?: number) => void;
  /** Show the burn-credit picks (user ask 2026-10-19: only where credits are reloaded). */
  picks?: boolean;
  /** A line above the picks, such as what the wallet holds now. */
  children?: ReactNode;
}) {
  const { open, buckets } = useCreditBuckets(picks);
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
                ? "Each pick is quoted now to get at least that many credits, with 1% room for the price moving. No TrenchScanner fee."
                : "TrenchScanner takes no fee on this buy."}
            </small>
          </div>
        </>
      )}
    </section>
  );
}
