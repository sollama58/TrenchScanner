import { useEffect, useRef, useState } from "react";
import { privyConfig } from "../privyBridge";
import {
  expectedTokens,
  MIN_TRADE_SOL,
  readTradeSettings,
  runTrade,
  useSwapCosts,
  type TradeStage,
} from "../proTrade";
import { TwoFactorCancelled } from "../twoFactor";
import { decimalUnits } from "../decimal";
import { tokensText } from "./TradePanel";

/**
 * The paywall's in-app $ASDFASDFA buy (user decision 2026-10-18): SOL in the signed-in wallet
 * swapped for the access token through Jupiter, at no TrenchScanner fee, then burned with the
 * burn button below. Open only while Pro trading is open to everyone; the API refuses any other
 * coin for a wallet without Pro Mode (no size cap since 2026-10-18, user decision).
 */

const MIN_LAMPORTS = BigInt(Math.round(MIN_TRADE_SOL * 1e9));

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
  // "0.5" or "0,5" (decimal.ts), to the lamport.
  const lamports = decimalUnits(sol, 9, 6);
  const valid = lamports !== null && lamports >= MIN_LAMPORTS;
  const quote = useSwapCosts(open && valid ? mint : null, valid ? Number(lamports) / 1e9 : 0);
  const expected = valid ? expectedTokens(lamports, quote, null) : null;
  if (!open) return null;

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
          amount: lamports!,
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
          inputMode="decimal"
          autoComplete="off"
          value={sol}
          disabled={stage !== null}
          onChange={(e) => setSol(e.target.value)}
        />
        <button className="button primary" disabled={!valid || stage !== null} onClick={() => void buy()}>
          {stage ? STAGE_TEXT[stage] : "Buy $ASDFASDFA"}
        </button>
      </div>
      {!valid && <p className="faint small">At least {MIN_TRADE_SOL} SOL.</p>}
      {expected && (
        <p className="faint small num">
          ≈ {tokensText(expected.tokens)} $ASDFASDFA{expected.quoted ? "" : " (est.)"}
        </p>
      )}
      {done && <p className="small good-text">Bought. Burn it below to get access.</p>}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
