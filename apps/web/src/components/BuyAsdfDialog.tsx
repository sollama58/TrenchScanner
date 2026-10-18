import { useEffect, useMemo, useRef, useState } from "react";
import { privyConfig } from "../privyBridge";
import { summarizePosition, useCanSignTrades, usePosition, useProState } from "../proTrade";
import { shortAddress } from "../format";
import { formatTokens, type BurnBalance } from "../burn";
import { TradePanel } from "./TradePanel";
import { CloseIcon, FlameIcon } from "./Icons";

/**
 * Buying $ASDFASDFA on the site (user ask 2026-10-18): the token modal's Trade panel for the access
 * token, in its own popup, for every signed-in wallet. A wallet without Pro Mode gets the Buy side
 * only (the API lets it buy this one coin, up to 5 SOL at a time, and nothing else). Opened from
 * Settings' Subscription section and the burn panel's "Buy $ASDFASDFA here".
 */
/** The API's ACCESS_BUY_MAX_LAMPORTS, in SOL: one buy's cap for a wallet without Pro Mode. */
const ACCESS_BUY_MAX_SOL = 5;

export function BuyAsdfDialog({
  owner,
  mint,
  onClose,
  onBought,
  balance = null,
}: {
  /** The signed-in wallet: it pays and receives. */
  owner: string;
  mint: string;
  onClose: () => void;
  /** After each trade, so the page can read its balances again. */
  onBought: () => void;
  /** The page's reading of the wallet's SOL and $ASDFASDFA, shown above the panel. */
  balance?: BurnBalance | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pro = useProState();
  const position = usePosition(mint);
  const canSign = useCanSignTrades(owner);
  // The access buy follows the trading kill switch; null while asking.
  const [open, setOpen] = useState<boolean | null>(null);
  const summary = useMemo(
    () => (position.data ? summarizePosition(position.data, null) : null),
    [position.data],
  );
  const buyOnly = !(pro?.pro && pro.wallet === owner);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    let live = true;
    void privyConfig().then((c) => live && setOpen(c.accessSwap === true));
    return () => {
      live = false;
    };
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
          Swap SOL from your wallet ({shortAddress(owner)}) for $ASDFASDFA, then burn it in Settings for
          access. TrenchScanner takes no fee.{buyOnly ? " Up to 5 SOL a buy." : ""}
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
          <TradePanel
            owner={owner}
            mint={mint}
            symbol="ASDFASDFA"
            name="ASDFASDFA"
            position={position.data}
            summary={summary}
            buyOnly={buyOnly}
            hidePosition
            maxBuySol={buyOnly ? ACCESS_BUY_MAX_SOL : null}
            onTraded={() => {
              position.reload();
              onBought();
            }}
          />
        )}
      </div>
    </dialog>
  );
}
