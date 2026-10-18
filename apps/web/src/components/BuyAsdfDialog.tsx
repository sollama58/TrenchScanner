import { useEffect, useMemo, useRef, useState } from "react";
import { privyConfig } from "../privyBridge";
import { summarizePosition, useCanSignTrades, usePosition, useProState } from "../proTrade";
import { shortAddress } from "../format";
import { TradePanel } from "./TradePanel";
import { CloseIcon, FlameIcon } from "./Icons";

/**
 * Buying $ASDFASDFA on the site (user ask 2026-10-18): the token modal's Trade panel for the access
 * token, in its own popup, for every signed-in wallet. A wallet without Pro Mode gets the Buy side
 * only (the API lets it buy this one coin, up to 5 SOL at a time, and nothing else). Opened from
 * Settings' Subscription section and the burn panel's "Buy $ASDFASDFA here".
 */
export function BuyAsdfDialog({
  owner,
  mint,
  onClose,
  onBought,
}: {
  /** The signed-in wallet: it pays and receives. */
  owner: string;
  mint: string;
  onClose: () => void;
  /** After each trade, so the page can read its balances again. */
  onBought: () => void;
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
