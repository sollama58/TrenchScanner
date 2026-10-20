import { useEffect, useRef, useState } from "react";
import {
  disclaimerAccepted,
  quickBuyShown,
  runTrade,
  tradeCooldownLeft,
  tradePacePhrase,
  useCanSignTrades,
  useProState,
  useTradeSettings,
  type QuickBuySettings,
  type TradeStage,
} from "../proTrade";
import { TwoFactorCancelled } from "../twoFactor";
import { BoltIcon } from "./Icons";

/**
 * The quick-buy pill on alert and stream cards (user ask 2026-10-18): one tap buys the amount set
 * in Settings > Trading, with the same settings, checks and wallet as the Trade panel. Off by
 * default, hidden while the amount is blank or 0, and only for a Pro Mode wallet this device can
 * sign for. A wallet that hasn't accepted
 * the trading disclaimer yet is sent to the token window, where it is shown.
 *
 * Without `slot` it floats in the picked corner of its card (Stream rows). With `slot`, the card
 * places one pill per corner in its own rows and only the one matching Settings > Trading shows, so
 * it sits beside the card's other pills instead of pushing the card down a line (user ask 2026-10-18).
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
  slot,
}: {
  mint: string;
  symbol: string;
  /** Opens the token window (the disclaimer and the full Trade panel are there). */
  onNeedsPanel: () => void;
  /** The corner this spot in the card's layout stands for; it shows only when that one is picked. */
  slot?: QuickBuySettings["position"];
}) {
  const pro = useProState();
  const settings = useTradeSettings();
  const q = settings.quickBuy;
  const owner = pro?.pro ? pro.wallet : null;
  const here = !slot || slot === q.position;
  // Only while it's switched on with an amount (and in this spot): a feed of cards shouldn't each
  // watch the wallet list for nothing.
  const shown = quickBuyShown(q) && here;
  const canSign = useCanSignTrades(shown ? owner : null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  // A result shows for a moment, then the pill is ready again.
  useEffect(() => {
    if (state.kind !== "done" && state.kind !== "failed") return;
    const t = setTimeout(() => setState({ kind: "idle" }), state.kind === "done" ? 3_000 : 6_000);
    return () => clearTimeout(t);
  }, [state]);

  if (!owner || !shown || !canSign) return null;

  const buy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.kind === "busy") return;
    if (!disclaimerAccepted(owner)) {
      onNeedsPanel();
      return;
    }
    // The API's one trade per second per wallet, said here without a round trip.
    const left = tradeCooldownLeft(owner);
    if (left > 0) {
      setState({
        kind: "failed",
        message: `One trade ${tradePacePhrase()}: try again in ${Math.ceil(left / 1_000)}s.`,
      });
      return;
    }
    if (q.amountSol >= CONFIRM_BUY_SOL && !window.confirm(`Buy ${q.amountSol} SOL of ${symbol}?`)) return;
    setState({ kind: "busy", stage: "building" });
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await runTrade(
        {
          owner,
          mint,
          side: "buy",
          amount: BigInt(Math.round(q.amountSol * 1e9)),
          settings,
          signal: ac.signal,
        },
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
          : // Just the amount (user ask 2026-10-19): the bolt and the tooltip say it's a SOL buy.
            String(q.amountSol);
  const title =
    state.kind === "failed"
      ? state.message
      : state.kind === "done"
        ? `Bought ${q.amountSol} SOL of ${symbol}`
        : `Quick buy: ${q.amountSol} SOL of ${symbol} (change it in Settings > Trading)`;

  return (
    <button
      type="button"
      className={`quick-buy ${slot ? `qb-slot qb-at-${slot}` : `qb-${q.position}`} qb-${q.size} qb-${q.color} qb-${state.kind}`}
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
