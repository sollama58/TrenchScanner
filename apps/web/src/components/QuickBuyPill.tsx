import { useEffect, useState } from "react";
import {
  disclaimerAccepted,
  runTrade,
  useCanSignTrades,
  useProState,
  useTradeSettings,
  type TradeStage,
} from "../proTrade";
import { TwoFactorCancelled } from "../twoFactor";
import { BoltIcon } from "./Icons";

/**
 * The quick-buy pill on alert and stream cards (user ask 2026-10-18): one tap buys the amount set
 * in Settings > Trading, with the same settings, checks and wallet as the Trade panel. Off by
 * default, and only for a Pro Mode wallet this device can sign for. A wallet that hasn't accepted
 * the trading disclaimer yet is sent to the token window, where it is shown.
 */

/** Buys this size or more ask first, as in the Trade panel. */
const CONFIRM_BUY_SOL = 5;

type State =
  | { kind: "idle" }
  | { kind: "busy"; stage: TradeStage }
  | { kind: "done" }
  | { kind: "failed"; message: string };

export function QuickBuyPill({
  mint,
  symbol,
  onNeedsPanel,
}: {
  mint: string;
  symbol: string;
  /** Opens the token window (the disclaimer and the full Trade panel are there). */
  onNeedsPanel: () => void;
}) {
  const pro = useProState();
  const settings = useTradeSettings();
  const q = settings.quickBuy;
  const owner = pro?.pro ? pro.wallet : null;
  // Only while it's switched on: a feed of cards shouldn't each watch the wallet list for nothing.
  const canSign = useCanSignTrades(q.enabled ? owner : null);
  const [state, setState] = useState<State>({ kind: "idle" });

  // A result shows for a moment, then the pill is ready again.
  useEffect(() => {
    if (state.kind !== "done" && state.kind !== "failed") return;
    const t = setTimeout(() => setState({ kind: "idle" }), state.kind === "done" ? 3_000 : 6_000);
    return () => clearTimeout(t);
  }, [state]);

  if (!owner || !q.enabled || !canSign) return null;

  const buy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.kind === "busy") return;
    if (!disclaimerAccepted(owner)) {
      onNeedsPanel();
      return;
    }
    if (q.amountSol >= CONFIRM_BUY_SOL && !window.confirm(`Buy ${q.amountSol} SOL of ${symbol}?`)) return;
    setState({ kind: "busy", stage: "building" });
    try {
      await runTrade(
        { owner, mint, side: "buy", amount: BigInt(Math.round(q.amountSol * 1e9)), settings },
        (stage) => setState({ kind: "busy", stage }),
      );
      setState({ kind: "done" });
    } catch (err) {
      if (err instanceof TwoFactorCancelled) setState({ kind: "idle" });
      else setState({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const label =
    state.kind === "busy"
      ? state.stage === "signing"
        ? "Sign…"
        : "…"
      : state.kind === "done"
        ? "Bought"
        : state.kind === "failed"
          ? "Failed"
          : `${q.amountSol} SOL`;
  const title =
    state.kind === "failed"
      ? state.message
      : state.kind === "done"
        ? `Bought ${q.amountSol} SOL of ${symbol}`
        : `Quick buy: ${q.amountSol} SOL of ${symbol} (change it in Settings > Trading)`;

  return (
    <button
      type="button"
      className={`quick-buy qb-${q.position} qb-${q.size} qb-${q.color} qb-${state.kind}`}
      onClick={(e) => void buy(e)}
      disabled={state.kind === "busy"}
      title={title}
      aria-label={title}
    >
      <BoltIcon size={q.size === "s" ? 10 : q.size === "l" ? 14 : 12} />
      <span className="num">{label}</span>
    </button>
  );
}
