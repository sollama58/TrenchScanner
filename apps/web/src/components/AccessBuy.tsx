import { useEffect, useRef, useState } from "react";
import { privyConfig } from "../privyBridge";
import { MIN_TRADE_SOL, readTradeSettings, runTrade, type TradeStage } from "../proTrade";
import { TwoFactorCancelled } from "../twoFactor";

/**
 * The paywall's in-app $ASDFASDFA buy (user decision 2026-10-18): SOL in the signed-in wallet
 * swapped for the access token through Jupiter, at no TrenchScanner fee, then burned with the
 * burn button below. Open only while Pro trading is open to everyone; the API refuses any other
 * coin, and more than 5 SOL, for a wallet without Pro Mode.
 */

/** The API's ACCESS_BUY_MAX_LAMPORTS, in SOL. */
const MAX_SOL = 5;

const STAGE_TEXT: Record<TradeStage, string> = {
  building: "Getting a price…",
  signing: "Approve it in your wallet…",
  sending: "Sending…",
  confirming: "Waiting for Solana…",
};

export function AccessBuy({
  walletAddress,
  mint,
  onBought,
}: {
  walletAddress: string;
  mint: string;
  onBought: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sol, setSol] = useState("0.1");
  const [stage, setStage] = useState<TradeStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    let live = true;
    void privyConfig().then((c) => live && setOpen(c.accessSwap === true));
    return () => {
      live = false;
    };
  }, []);
  if (!open) return null;

  const amount = Number(sol);
  const valid = Number.isFinite(amount) && amount >= MIN_TRADE_SOL && amount <= MAX_SOL;

  const buy = async () => {
    // A ref, not the stage: the stage is first set only after the wallet's connect prompt, so a
    // double click used to build two swaps.
    if (!valid || stage || busy.current) return;
    busy.current = true;
    setError(null);
    setDone(false);
    try {
      await runTrade(
        {
          owner: walletAddress,
          mint,
          side: "buy",
          amount: BigInt(Math.round(amount * 1e9)),
          settings: readTradeSettings(),
        },
        (s) => setStage(s),
      );
      setDone(true);
      onBought();
    } catch (e) {
      if (!(e instanceof TwoFactorCancelled)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      setStage(null);
    }
  };

  return (
    <div className="access-buy">
      <p className="small">
        <strong>No $ASDFASDFA yet?</strong> Swap SOL from this wallet for it here. TrenchScanner takes no fee;
        you pay only Solana&apos;s network fee.
      </p>
      <div className="access-buy-row">
        <label className="small muted" htmlFor="access-buy-sol">
          SOL to spend
        </label>
        <input
          id="access-buy-sol"
          type="number"
          inputMode="decimal"
          min={MIN_TRADE_SOL}
          max={MAX_SOL}
          step={0.01}
          value={sol}
          disabled={stage !== null}
          onChange={(e) => setSol(e.target.value)}
        />
        <button className="button primary" disabled={!valid || stage !== null} onClick={() => void buy()}>
          {stage ? STAGE_TEXT[stage] : "Buy $ASDFASDFA"}
        </button>
      </div>
      {!valid && <p className="faint small">Between 0.001 and {MAX_SOL} SOL.</p>}
      {done && <p className="small good-text">Bought. Burn it below to get access.</p>}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
