import { useEffect, useMemo, useRef, useState } from "react";
import { summarizePosition, useCanSignTrades, usePosition, useProState } from "../proTrade";
import { shortAddress } from "../format";
import { formatTokens, type BurnBalance } from "../burn";
import { type Subscription } from "../api";
import { usePolling } from "../hooks";
import { TradePanel } from "./TradePanel";
import { CloseIcon, FlameIcon } from "./Icons";
import { CreditBucketPicks, useCreditBuckets } from "./GetAsdf";

/**
 * Buying $ASDFASDFA on the site (user ask 2026-10-18): the token modal's Trade panel for the access
 * token, in its own popup, for every signed-in wallet. A wallet without Pro Mode gets the Buy side
 * only (the API lets it buy this one coin, any size, and nothing else). No account pays the
 * TrenchScanner fee on it (user ask 2026-10-19). Opened from Settings' Subscription section and
 * every "Get $ASDFASDFA" section (GetAsdf.tsx), whose credit picks arrive as `initialSol`.
 */

export function BuyAsdfDialog({
  owner,
  mint,
  onClose,
  onBought,
  balance = null,
  initialSol,
  picks = false,
}: {
  /** The signed-in wallet: it pays and receives. */
  owner: string;
  mint: string;
  onClose: () => void;
  /** After each trade, so the page can read its balances again. */
  onBought: () => void;
  /** The page's reading of the wallet's SOL and $ASDFASDFA, shown above the panel. */
  balance?: BurnBalance | null;
  /** The SOL a credit pick chose before the popup opened. */
  initialSol?: number;
  /** Show the burn-credit picks: opened from a credit reload area (UtilitiesTab's CreditBurn). */
  picks?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pro = useProState();
  const position = usePosition(mint);
  const canSign = useCanSignTrades(owner);
  // The access buy follows the trading kill switch; null while asking.
  const { open, buckets } = useCreditBuckets(picks);
  // What a buy comes to in burn credits (a credit reload) or access (everywhere else).
  const sub = usePolling<Subscription>("/subscription", 300_000);
  const price = sub.data?.price;
  const expectNote = (tokens: number): string | null => {
    if (picks) {
      if (!price?.tokensPerCredit) return null;
      const credits = Math.floor(tokens / price.tokensPerCredit);
      return `about ${credits.toLocaleString("en-US")} burn credit${credits === 1 ? "" : "s"}`;
    }
    if (!price?.tokensPerMonth) return null;
    const days = Math.floor((tokens / price.tokensPerMonth) * price.daysPerMonth);
    return `about ${days.toLocaleString("en-US")} day${days === 1 ? "" : "s"} of access`;
  };
  const [fill, setFill] = useState<{ sol: number; at: number } | null>(() =>
    initialSol ? { sol: initialSol, at: Date.now() } : null,
  );
  const [picked, setPicked] = useState<number | null>(null);
  const summary = useMemo(
    () => (position.data ? summarizePosition(position.data, null) : null),
    [position.data],
  );
  const buyOnly = !(pro?.pro && pro.wallet === owner);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="about-modal asdf-buy-modal"
      aria-label="Buy $ASDFASDFA"
      onClose={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h3>
            <FlameIcon size={16} /> Buy $ASDFASDFA
          </h3>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        <p className="small">
          Swap SOL from your wallet ({shortAddress(owner)}) for $ASDFASDFA, then burn it for access or
          credits. <strong className="good-text">No TrenchScanner fee on this buy</strong>, for every account.
        </p>
        {balance && (
          <div className="asdf-buy-wallet">
            <span>
              <small className="muted">SOL</small>
              <strong className="num">
                {balance.solLamports != null
                  ? (Number(balance.solLamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })
                  : "–"}
              </strong>
            </span>
            <span>
              <small className="muted">$ASDFASDFA</small>
              <strong className="num">{formatTokens(BigInt(balance.totalRaw), balance.decimals)}</strong>
            </span>
          </div>
        )}
        {balance?.solLamports === "0" && (
          <p className="notice small">
            Your wallet has no SOL yet. Send SOL to <code className="num">{owner}</code> from another wallet
            or an exchange, then buy.
          </p>
        )}
        {open === null ? (
          <p className="muted small">Loading…</p>
        ) : !open ? (
          <p className="small">
            Buying on the site is paused right now.{" "}
            <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer">
              Get $ASDFASDFA on Pump.fun
            </a>{" "}
            instead.
          </p>
        ) : !canSign ? (
          <p className="small">
            The wallet you signed in with ({shortAddress(owner)}) isn&apos;t available in this browser, so a
            buy can&apos;t be signed here. Open TrenchScanner where that wallet is, or sign in again with it.
          </p>
        ) : (
          <>
            {picks && buckets.length > 0 && (
              <div className="asdf-buy-picks">
                <small className="muted">Buy by burn credits, at the current rate</small>
                <CreditBucketPicks
                  buckets={buckets}
                  picked={picked}
                  onPick={(b) => {
                    if (b.sol === null) return;
                    setPicked(b.credits);
                    setFill({ sol: b.sol, at: Date.now() });
                  }}
                />
              </div>
            )}
            <TradePanel
              owner={owner}
              mint={mint}
              symbol="ASDFASDFA"
              name="ASDFASDFA"
              position={position.data}
              summary={summary}
              buyOnly={buyOnly}
              hidePosition
              fillBuy={fill}
              expectNote={expectNote}
              onTraded={() => {
                position.reload();
                onBought();
              }}
            />
          </>
        )}
      </div>
    </dialog>
  );
}
