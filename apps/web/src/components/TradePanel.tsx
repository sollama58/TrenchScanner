import { useState } from "react";
import { ApiError } from "../api";
import { signedPct, usd } from "../format";
import {
  graceLeftText,
  MAX_CUSTOM_FEE_SOL,
  MIN_TIP_SOL,
  BUY_PRESETS_PER_ROW,
  useTradeSettings,
  acceptDisclaimer,
  disclaimerAccepted,
  useFeeEstimate,
  useSwapCosts,
  runTrade,
  saveTradeSettings,
  TradeError,
  type FeeEstimate,
  type SwapCostEstimate,
  type PositionResponse,
  type PositionSummary,
  type TradeSettings,
  type TradeStage,
  MIN_TRADE_SOL,
} from "../proTrade";
import { WalletTimeoutError } from "../wallet";
import { renderPositionCard } from "../pnlCard";
import { BoltIcon, CheckIcon, ChevronDownIcon, GearIcon, InfoIcon, ShareIcon, ShieldIcon } from "./Icons";
import { ShareImageDialog } from "./ShareImageDialog";

/**
 * Pro Mode's Trade panel under the token modal's chart (user ask 2026-10-17): buy and sell the
 * coin with the signed-in wallet, and see the position - what it holds, what it paid, PnL. The
 * chart above it grows and marks the trades while this is open or the wallet holds the coin.
 *
 * No TrenchScanner fee. What a trade costs beyond the swap is the network's: a priority fee and
 * Helius Sender's tip (0.000005 SOL on Eco, 0.001 SOL on Turbo), broken down under the buttons.
 *
 * Redrawn 2026-10-18 (user ask): its own always-open section, Buy and Sell side by side (stacked
 * on a phone), the position with a share card, and the fee explainer as a breakdown.
 */

const LAMPORTS = 1_000_000_000;
/**
 * The trade limits the API enforces (proTrade.ts, user ask 2026-10-18), checked here first so the
 * panel can say so without a round trip: 0.01 SOL at least, one trade every 5 seconds per wallet,
 * and a sale of 100% (closing the position) exempt from both.
 */
const TRADE_COOLDOWN_MS = 5_000;
const TRADE_LIMITS_TEXT = "Trades start at 0.01 SOL, one every 5 seconds. Selling 100% is always allowed.";
/** When each wallet last sent a trade from this page, across every open token. */
const lastSentAt = new Map<string, number>();

export function solText(sol: number, signed = false): string {
  const abs = Math.abs(sol);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : 6;
  const text = `${abs.toFixed(digits).replace(/\.?0+$/, "")} SOL`;
  return signed ? `${sol > 0 ? "+" : sol < 0 ? "-" : ""}${text}` : text;
}

/** Whole tokens, shortened: 1.23M, 456K, 12.3. */
export function tokensText(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(abs >= 1 ? 2 : 4);
}

/** A typed SOL amount as lamports, or null when it isn't one. */
export function parseSol(text: string): bigint | null {
  const m = /^\s*(\d{0,6})(?:\.(\d{0,9}))?\s*$/.exec(text);
  if (!m || (!m[1] && !m[2])) return null;
  const lamports = BigInt(m[1] || "0") * BigInt(LAMPORTS) + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
  return lamports > 0n ? lamports : null;
}

/** `pct` percent of a raw balance; all of it at 100. */
export function shareOf(raw: bigint, pct: number): bigint {
  if (pct >= 100) return raw;
  return (raw * BigInt(Math.round(pct * 100))) / 10_000n;
}

/** A fee estimate's total, SOL: the priority fee, Sender's tip and the base fee. */
export function feeTotalSol(fee: {
  priorityFeeLamports: string;
  tipLamports: string;
  baseFeeLamports: string;
}): number {
  return (Number(fee.priorityFeeLamports) + Number(fee.tipLamports) + Number(fee.baseFeeLamports)) / LAMPORTS;
}

/** Shown once before a wallet's first trade, and kept under the panel after (user ask 2026-10-18). */
export const TRADE_DISCLAIMER =
  "Trading here is non-custodial: TrenchScanner never holds your keys or funds and only sees your wallet's public address. " +
  "Each trade is built by our server and signed by your own wallet, and once sent it can't be undone. " +
  "TrenchScanner is open-source software created largely with machine learning models, so it may have bugs. " +
  "Check every trade in your wallet before you sign it, trade only what you can afford to lose, and treat nothing here as financial advice.";

/** Buys this size or more ask before they start. */
const CONFIRM_BUY_LAMPORTS = 5n * BigInt(LAMPORTS);

/** What the build quotes, said before the wallet asks to sign: "About 1.2M PEPE, at least 1.02M." */
export function quoteText(
  built: { quotedOut: string; minOut: string; priorityFeeLamports: string; tipLamports: string },
  side: "buy" | "sell",
  position: { decimals: number | null } | null,
  symbol: string,
): string {
  // Network fees only (priority fee, Sender tip, base fee): there is no platform fee to add.
  const fees =
    (Number(BigInt(built.priorityFeeLamports)) + Number(BigInt(built.tipLamports)) + 5_000) / LAMPORTS;
  if (side === "sell")
    return `About ${solText(Number(BigInt(built.quotedOut)) / LAMPORTS)}, at least ${solText(Number(BigInt(built.minOut)) / LAMPORTS)}; network fee ${solText(fees)}, no platform fee.`;
  const scale = 10 ** (position?.decimals ?? 6);
  return `About ${tokensText(Number(BigInt(built.quotedOut)) / scale)} ${symbol}, at least ${tokensText(Number(BigInt(built.minOut)) / scale)}; network fee ${solText(fees)}, no platform fee.`;
}

const STAGE_TEXT: Record<TradeStage, string> = {
  building: "Building and checking the trade…",
  signing: "Approve it in your wallet…",
  sending: "Sending through Helius Sender…",
  confirming: "Waiting for the chain to confirm…",
};

type Status =
  | { kind: "idle" }
  | { kind: "busy"; stage: TradeStage; what: string; quote?: string }
  | { kind: "done"; text: string; signature: string }
  | { kind: "error"; text: string; signature?: string };

function errorText(e: unknown): string {
  if (e instanceof WalletTimeoutError)
    return e.message === "connect"
      ? "The wallet didn't answer. Unlock it and try again."
      : "The wallet didn't sign in time. Nothing was sent.";
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  if (code === 4001 || /reject|denied|declin|cancel/i.test(message))
    return "You cancelled in the wallet. Nothing was sent.";
  if (e instanceof ApiError || e instanceof TradeError) return message;
  return message || "The trade stopped without saying why.";
}

const STAGES: { id: TradeStage; label: string }[] = [
  { id: "building", label: "Build" },
  { id: "signing", label: "Sign" },
  { id: "sending", label: "Send" },
  { id: "confirming", label: "Confirm" },
];

/** The four steps of a trade, the current one lit, the ones before it done. */
function StageSteps({ stage }: { stage: TradeStage }) {
  const at = STAGES.findIndex((s) => s.id === stage);
  return (
    <ol className="tm-trade-steps" aria-hidden="true">
      {STAGES.map((s, i) => (
        <li key={s.id} className={i < at ? "done" : i === at ? "on" : ""}>
          <i />
          {s.label}
        </li>
      ))}
    </ol>
  );
}

/** A warning sign, drawn like the emoji: an amber triangle with a dark exclamation mark. */
function WarnTriangle() {
  return (
    <svg className="tm-warn-tri" width="26" height="24" viewBox="0 0 26 24" aria-hidden="true">
      <defs>
        <linearGradient id="tm-warn-tri-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd34d" />
          <stop offset="1" stopColor="#f5a00b" />
        </linearGradient>
      </defs>
      <path
        d="M11.27 2.1a2 2 0 0 1 3.46 0l10 17.3A2 2 0 0 1 23 22.4H3a2 2 0 0 1-1.73-3l10-17.3Z"
        fill="url(#tm-warn-tri-fill)"
        stroke="#c97a00"
        strokeWidth="0.8"
      />
      <rect x="11.6" y="7.5" width="2.8" height="8.2" rx="1.4" fill="#2b1d00" />
      <circle cx="13" cy="18.6" r="1.55" fill="#2b1d00" />
    </svg>
  );
}

/** "1%", "0.25%", "3%": basis points as a percent. */
function bpsText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/**
 * What a buy costs in all (user ask 2026-10-18): one bar for the whole swap cost, color coded,
 * the network's fee, the pools' fees, the coin's own transfer tax and a first buy's account rent,
 * with TrenchScanner's 0% up top. Sized on the typed amount, or the first buy button.
 */
function FeeExplainer({
  fee,
  swap,
  solUsd,
  sizeSol,
}: {
  fee: FeeEstimate | null;
  swap: SwapCostEstimate | null;
  solUsd: number | null;
  sizeSol: number;
}) {
  const network = fee
    ? [
        { key: "priority", label: "Priority fee", sol: Number(fee.priorityFeeLamports) / LAMPORTS },
        { key: "tip", label: "Helius Sender tip", sol: Number(fee.tipLamports) / LAMPORTS },
        { key: "base", label: "Base fee", sol: Number(fee.baseFeeLamports) / LAMPORTS },
      ]
    : [];
  const swapParts = swap
    ? [
        ...(swap.poolFeeBps !== null
          ? [
              {
                key: "pool",
                label: `Pool and LP fees${swap.venues.length ? ` (${swap.venues.join(", ")})` : ""}`,
                sol: (sizeSol * swap.poolFeeBps) / 10_000,
                rate: bpsText(swap.poolFeeBps),
              },
            ]
          : []),
        ...(swap.transferFeeBps !== null && swap.transferFeeBps > 0
          ? [
              {
                key: "tax",
                label: "Token transfer tax",
                sol: (sizeSol * (swap.transferFeeBps ?? 0)) / 10_000,
                rate: bpsText(swap.transferFeeBps ?? 0),
              },
            ]
          : []),
        ...(Number(swap.accountRentLamports) > 0
          ? [
              {
                key: "rent",
                label: "Token account rent (first buy, refundable)",
                sol: Number(swap.accountRentLamports) / LAMPORTS,
                rate: "",
              },
            ]
          : []),
      ]
    : [];
  const parts = [...network.map((p) => ({ ...p, rate: "" })), ...swapParts];
  const total = fee ? parts.reduce((sum, p) => sum + p.sol, 0) : null;
  const usdText = (sol: number) => {
    const v = sol * (solUsd ?? 0);
    return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(v < 0.1 ? 3 : 2)}`;
  };
  return (
    <div className="tm-trade-fee" aria-live="polite">
      <div className="tm-fee-head">
        <span className="tm-fee-title">
          Total cost of a <span className="num">{solText(sizeSol)}</span> buy
        </span>
        <span className="tm-fee-total">
          {total !== null ? (
            <>
              <strong className="num">{solText(total)}</strong>
              <small className="num muted">
                {sizeSol > 0 ? ` ${((total / sizeSol) * 100).toFixed(2)}% of the trade` : ""}
                {solUsd ? ` · ≈ ${usdText(total)}` : ""}
              </small>
            </>
          ) : (
            <span className="muted">Working it out…</span>
          )}
        </span>
      </div>
      {total !== null && total > 0 && (
        <div className="tm-fee-bar" role="img" aria-label="How the cost splits">
          {parts.map((p) => (
            <span
              key={p.key}
              className={p.key}
              title={`${p.label}: ${solText(p.sol)}`}
              style={{ flexGrow: Math.max(p.sol / total, 0.025) }}
            />
          ))}
        </div>
      )}
      <details className="tm-fee-more">
        <summary>
          <ChevronDownIcon size={13} />
          <span>Fee breakdown</span>
          {swap && swap.transferFeeBps !== null && swap.transferFeeBps > 0 && (
            <span className="tm-fee-tax-chip">⚠ {bpsText(swap.transferFeeBps ?? 0)} transfer tax</span>
          )}
        </summary>
        <div className="tm-fee-more-body">
          {fee && (
            <div className="tm-fee-groups">
              <div className="tm-fee-group">
                <span className="tm-fee-group-title">Solana network</span>
                <ul className="tm-fee-rows">
                  {network.map((p) => (
                    <li key={p.key}>
                      <i className={`tm-fee-dot ${p.key}`} aria-hidden="true" />
                      <span>{p.label}</span>
                      <span className="num">{solText(p.sol)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="tm-fee-group">
                <span className="tm-fee-group-title">The swap</span>
                <ul className="tm-fee-rows">
                  {swapParts.map((p) => (
                    <li key={p.key}>
                      <i className={`tm-fee-dot ${p.key}`} aria-hidden="true" />
                      <span>
                        {p.label}
                        {p.rate && <em className="num"> {p.rate}</em>}
                      </span>
                      <span className="num">{solText(p.sol)}</span>
                    </li>
                  ))}
                  {swap && (swap.transferFeeBps === 0 || swap.transferFeeBps === null) && (
                    <li className="tm-fee-none">
                      <i className="tm-fee-dot none" aria-hidden="true" />
                      <span>Token transfer tax</span>
                      <span className="num">{swap.transferFeeBps === 0 ? "none" : "couldn't read"}</span>
                    </li>
                  )}
                  {swap && swap.poolFeeBps === null && (
                    <li className="tm-fee-none">
                      <i className="tm-fee-dot none" aria-hidden="true" />
                      <span>Pool and LP fees</span>
                      <span className="num">in the quote</span>
                    </li>
                  )}
                  {!swap && (
                    <li className="tm-fee-none">
                      <i className="tm-fee-dot none" aria-hidden="true" />
                      <span>Pool fees and taxes couldn&apos;t be read just now</span>
                    </li>
                  )}
                  <li className="tm-fee-zero">
                    <i className="tm-fee-dot zero" aria-hidden="true" />
                    <span>TrenchScanner platform fee</span>
                    <strong className="num">0%</strong>
                  </li>
                </ul>
              </div>
            </div>
          )}
          {swap && swap.transferFeeBps !== null && swap.transferFeeBps > 0 && (
            <div className="tm-fee-warn" role="note">
              <WarnTriangle />
              <div>
                <strong>This coin has a {bpsText(swap.transferFeeBps)} transfer tax</strong>
                <p>
                  It comes off every buy and every sale, about{" "}
                  <span className="num">
                    {Number(((1 - (1 - swap.transferFeeBps / 10_000) ** 2) * 100).toFixed(2))}%
                  </span>{" "}
                  on a round trip before any other fee. It goes to whoever set the coin up, not to
                  TrenchScanner.
                </p>
              </div>
            </div>
          )}
          <ul className="tm-fee-notes">
            <li>
              <i className="tm-fee-dot priority" aria-hidden="true" />
              <span>
                <strong>Network fees</strong> go to Solana&apos;s validators.
              </span>
            </li>
            <li>
              <i className="tm-fee-dot pool" aria-hidden="true" />
              <span>
                <strong>Pool fees</strong> go to the pool and its liquidity providers.
              </span>
            </li>
            {swap?.priceImpactPct != null && (
              <li>
                <InfoIcon size={12} />
                <span>
                  <strong>Price impact</strong> on a {solText(Number(swap.refLamports) / LAMPORTS)} buy is
                  about <span className="num">{swap.priceImpactPct.toFixed(2)}%</span>, already in the quote
                  and capped by your slippage.
                </span>
              </li>
            )}
          </ul>
        </div>
      </details>
      <span className="tm-fee-zero-badge">
        <CheckIcon size={12} />
        <strong>0% platform fee</strong>
        <span className="tm-fee-zero-more">TrenchScanner takes nothing</span>
      </span>
    </div>
  );
}

/** A row of up to four preset buttons, two rows of three for five or six. */
/** The buy buttons' grid: every button in one row, or split over two (Settings > Trading). */
export function presetCols(n: number, rows: 1 | 2 = 1): React.CSSProperties {
  return { "--cols": Math.max(rows === 2 ? Math.ceil(n / 2) : n, 1) } as React.CSSProperties;
}

/** The sell buttons keep their old grid: up to four in a row. */
function sellCols(n: number): React.CSSProperties {
  return { "--cols": n <= 4 ? Math.max(n, 1) : 3 } as React.CSSProperties;
}

/** One figure in the holdings grid. */
function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="tm-hold-stat">
      <span className="tm-hold-label">{label}</span>
      <span className={`num tm-hold-value${tone ? ` ${tone}` : ""}`}>{value}</span>
      {sub && <small className="num muted">{sub}</small>}
    </div>
  );
}

export function TradePanel({
  owner,
  mint,
  symbol,
  name = null,
  position,
  summary,
  nowMcap = null,
  onTraded,
  closeOnly = false,
  graceEndsAt = null,
}: {
  owner: string;
  mint: string;
  symbol: string;
  name?: string | null;
  position: PositionResponse | null;
  summary: PositionSummary | null;
  /** The coin's market cap now (USD), for the holdings and the share card. */
  nowMcap?: number | null;
  onTraded: () => void;
  /** Pro Mode has ended: selling what it holds only (closing a position is always allowed). */
  closeOnly?: boolean;
  /** Out of the top 250 holders: when Pro Mode ends (ms). */
  graceEndsAt?: number | null;
}) {
  // Shared with Settings > Trading: a change there shows here at once, and the other way round.
  const settings = useTradeSettings();
  const [custom, setCustom] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showSettings, setShowSettings] = useState(false);
  const [accepted, setAccepted] = useState(() => disclaimerAccepted(owner));
  const [sharing, setSharing] = useState(false);
  const [shareAmounts, setShareAmounts] = useState(true);
  const busy = status.kind === "busy";
  const balance = position ? BigInt(position.balance) : 0n;
  const solUsd = position?.solUsd ?? null;

  const update = (patch: Partial<TradeSettings>) => {
    saveTradeSettings({ ...settings, ...patch });
  };

  const trade = async (side: "buy" | "sell", amount: bigint, what: string, all = false) => {
    if (busy || amount <= 0n || !accepted) return;
    const refuse = (text: string) => setStatus({ kind: "error", text });
    if (!all) {
      if (side === "buy" && amount < BigInt(Math.round(MIN_TRADE_SOL * LAMPORTS)))
        return refuse("The smallest buy is 0.01 SOL.");
      const worth =
        side === "sell" && summary?.valueSol != null && balance > 0n
          ? (summary.valueSol * Number(amount)) / Number(balance)
          : null;
      if (worth !== null && worth < MIN_TRADE_SOL)
        return refuse(
          "That sale is worth under 0.01 SOL, the smallest trade. Sell 100% to close the position.",
        );
      const left = (lastSentAt.get(owner) ?? -Infinity) + TRADE_COOLDOWN_MS - Date.now();
      if (left > 0) return refuse(`One trade every 5 seconds: try again in ${Math.ceil(left / 1_000)}s.`);
    }
    // A big buy is one click from a preset or a typo: ask first.
    if (side === "buy" && amount >= CONFIRM_BUY_LAMPORTS && !window.confirm(`${what} of ${symbol}?`)) return;
    setStatus({ kind: "busy", stage: "building", what });
    try {
      const signature = await runTrade({ owner, mint, side, amount, all, settings }, (stage, built) => {
        if (stage === "confirming") lastSentAt.set(owner, Date.now());
        setStatus({
          kind: "busy",
          stage,
          what,
          quote: built ? quoteText(built, side, position, symbol) : undefined,
        });
      });
      setStatus({ kind: "done", text: `${what}: confirmed.`, signature });
    } catch (e) {
      setStatus({
        kind: "error",
        text: errorText(e),
        signature: e instanceof TradeError ? e.signature : undefined,
      });
    } finally {
      onTraded();
    }
  };

  const customLamports = parseSol(custom);
  const fee = useFeeEstimate(mint, settings);
  const swapCosts = useSwapCosts(mint, settings.buyPresets[0] ?? 0.1);
  const hasPosition = !!summary && (summary.held > 0 || summary.buys > 0 || summary.sells > 0);
  const open = !!summary && summary.held > 0;
  const tone = summary?.pnlSol == null ? "" : summary.pnlSol >= 0 ? "up" : "down";
  const canShare = !!summary && summary.pnlSol !== null && summary.pnlPct !== null;
  const buyCustom = () =>
    customLamports && void trade("buy", customLamports, `Buy ${solText(Number(customLamports) / LAMPORTS)}`);

  return (
    <section className="sage-card tm-trade" aria-label="Trade">
      <header className="tm-trade-head">
        <h4>
          <BoltIcon size={14} /> Trade{symbol ? ` $${symbol}` : ""}
        </h4>
        <span className="tm-trade-tools">
          <span className="segmented small tm-trade-speed" role="radiogroup" aria-label="Speed">
            {(["eco", "turbo"] as const).map((sp) => (
              <button
                key={sp}
                type="button"
                role="radio"
                aria-checked={settings.speed === sp}
                className={`${settings.speed === sp ? "on" : ""} ${sp}`}
                title={
                  sp === "eco"
                    ? "One fast path, a 0.000005 SOL tip"
                    : "Every Helius path for the fastest landing, a 0.001 SOL tip: for launches where a slot matters"
                }
                onClick={() => update({ speed: sp })}
              >
                {sp === "eco" ? "Eco" : "Turbo"}
              </button>
            ))}
          </span>
          <button
            type="button"
            className={`ghost small tm-trade-gear${showSettings ? " on" : ""}`}
            aria-expanded={showSettings}
            onClick={() => setShowSettings(!showSettings)}
          >
            <GearIcon size={13} />
            <span className="num">{settings.slippagePct}%</span>
            <span className="tm-trade-gear-text">
              slip
              {settings.priorityMode === "custom" ? " · custom fee" : ""}
              {settings.mevProtect ? " · MEV shield" : ""}
            </span>
          </button>
        </span>
      </header>

      {graceEndsAt !== null && !closeOnly && (
        <p className="small tm-trade-warn" role="alert">
          Pro Mode ends in <strong className="num">{graceLeftText(graceEndsAt)}</strong> unless your wallet is
          confirmed in the top 250 $ASDFASDFA holders by then. After that you can't trade from here, sells
          included.
        </p>
      )}
      {closeOnly && (
        <p className="small tm-trade-warn">Pro Mode has ended for this wallet, so trading is off.</p>
      )}

      {hasPosition && summary && (
        <div className={`tm-hold ${tone}`}>
          <div className="tm-hold-hero">
            <div className="tm-hold-pnl">
              <span className="tm-hold-kicker">
                Your position{" "}
                <span className={`tm-hold-chip${open ? " open" : ""}`}>{open ? "Open" : "Closed"}</span>
              </span>
              {summary.pnlSol !== null ? (
                <span className="tm-hold-big">
                  <strong className={`num ${tone}`}>{solText(summary.pnlSol, true)}</strong>
                  <span className={`num tm-hold-pct ${tone}`}>
                    {signedPct((summary.pnlPct ?? 0) * 100, 1)}
                  </span>
                  {solUsd ? (
                    <small className="num muted">
                      {summary.pnlSol < 0 ? "-" : "+"}
                      {usd(Math.abs(summary.pnlSol * solUsd))}
                    </small>
                  ) : null}
                </span>
              ) : (
                <span className="tm-hold-big">
                  <strong className="num none">PnL –</strong>
                  <small className="muted">
                    {position?.truncated ? "older trades aren't counted" : "can't price it just now"}
                  </small>
                </span>
              )}
            </div>
            <button
              type="button"
              className="tm-hold-share"
              disabled={!canShare}
              title={
                canShare
                  ? "Share this position as an image (your wallet is never on it)"
                  : "Nothing to share yet"
              }
              onClick={() => setSharing(true)}
            >
              <ShareIcon size={14} /> Share PnL
            </button>
          </div>
          <div className="tm-hold-stats">
            <Stat
              label="Holding"
              value={open ? `${tokensText(summary.held)}` : "0"}
              sub={
                open && summary.valueSol !== null
                  ? `${solText(summary.valueSol)}${solUsd ? ` · ${usd(summary.valueSol * solUsd)}` : ""}`
                  : open
                    ? symbol
                    : "sold out"
              }
            />
            <Stat
              label="Avg entry"
              value={summary.entryMcap ? usd(summary.entryMcap) : "–"}
              sub={nowMcap ? `now ${usd(nowMcap)}` : undefined}
            />
            <Stat label="Put in" value={solText(summary.solIn)} sub={`${solText(summary.solOut)} back`} />
            <Stat
              label="Trades"
              value={`${summary.buys} / ${summary.sells}`}
              sub={`buy${summary.buys === 1 ? "" : "s"} / sell${summary.sells === 1 ? "" : "s"}`}
            />
          </div>
          {position?.historyUnavailable && (
            <p className="small muted tm-hold-note">Trade history is unavailable just now.</p>
          )}
        </div>
      )}

      {!accepted ? (
        <div className="tm-trade-disclaimer" role="note" aria-label="Before you trade">
          <ShieldIcon size={18} />
          <p className="small">
            <strong>Before your first trade.</strong> {TRADE_DISCLAIMER}
          </p>
          <button
            className="primary"
            onClick={() => {
              acceptDisclaimer(owner);
              setAccepted(true);
            }}
          >
            I understand
          </button>
        </div>
      ) : (
        <div className={`tm-trade-sides${closeOnly ? " one" : ""}`}>
          {!closeOnly && (
            <div className="tm-side buy" role="group" aria-label="Buy">
              <div className="tm-side-head">
                <span className="tm-side-title">Buy</span>
                <span className="muted small">with SOL</span>
              </div>
              <div className="tm-presets" style={presetCols(settings.buyPresets.length, settings.buyRows)}>
                {settings.buyPresets.map((sol) => (
                  <button
                    key={sol}
                    type="button"
                    className="tm-preset"
                    disabled={busy}
                    onClick={() => trade("buy", BigInt(Math.round(sol * LAMPORTS)), `Buy ${solText(sol)}`)}
                  >
                    <span className="num">{sol}</span>
                    <small>SOL</small>
                  </button>
                ))}
              </div>
              <div className="tm-amount">
                <span className="tm-amount-field">
                  <input
                    inputMode="decimal"
                    placeholder="Amount"
                    aria-label="Buy amount in SOL"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") buyCustom();
                    }}
                  />
                  <span className="tm-amount-unit">SOL</span>
                </span>
                <button
                  type="button"
                  className="tm-go"
                  disabled={busy || !customLamports}
                  onClick={buyCustom}
                >
                  Buy
                </button>
              </div>
            </div>
          )}
          <div className="tm-side sell" role="group" aria-label="Sell">
            <div className="tm-side-head">
              <span className="tm-side-title">Sell</span>
              <span className="muted small num">
                {balance > 0n && summary ? `${tokensText(summary.held)} ${symbol} held` : "nothing held"}
              </span>
            </div>
            <div className="tm-presets" style={sellCols(settings.sellPresets.length)}>
              {settings.sellPresets.map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className="tm-preset"
                  disabled={busy || balance === 0n}
                  title={balance === 0n ? "Nothing to sell" : undefined}
                  onClick={() => trade("sell", shareOf(balance, pct), `Sell ${pct}%`, pct >= 100)}
                >
                  <span className="num">{pct}%</span>
                  {pct >= 100 && <small>all</small>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="tm-trade-settings">
          <label className="tm-set">
            <span>Slippage</span>
            <span className="tm-set-input">
              <input
                type="number"
                min={0.1}
                max={50}
                step={0.5}
                value={settings.slippagePct}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 0.1 && v <= 50) update({ slippagePct: v });
                }}
              />
              <i>%</i>
            </span>
          </label>
          <div className="tm-set">
            <span>Priority fee</span>
            <span className="segmented small" role="radiogroup" aria-label="Priority fee">
              {(["auto", "custom"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={settings.priorityMode === m}
                  className={settings.priorityMode === m ? "on" : ""}
                  title={
                    m === "auto"
                      ? "The network's going rate, capped at 0.00005 SOL on Eco and 0.001 SOL on Turbo"
                      : "Your own priority fee per trade"
                  }
                  onClick={() => update({ priorityMode: m })}
                >
                  {m === "auto" ? "Auto" : "Custom"}
                </button>
              ))}
            </span>
          </div>
          {settings.priorityMode === "custom" && (
            <label className="tm-set">
              <span>Your priority fee</span>
              <span className="tm-set-input">
                <input
                  type="number"
                  min={0}
                  max={MAX_CUSTOM_FEE_SOL}
                  step={0.00001}
                  defaultValue={settings.customPrioritySol}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 0 && v <= MAX_CUSTOM_FEE_SOL)
                      update({ customPrioritySol: v });
                  }}
                />
                <i>SOL</i>
              </span>
            </label>
          )}
          <label
            className="tm-set"
            title={`At least ${MIN_TIP_SOL[settings.speed]} SOL on ${settings.speed === "turbo" ? "Turbo" : "Eco"}`}
          >
            <span>Sender tip</span>
            <span className="tm-set-input">
              <input
                type="number"
                min={MIN_TIP_SOL[settings.speed]}
                max={MAX_CUSTOM_FEE_SOL}
                step={0.000001}
                placeholder={`${MIN_TIP_SOL[settings.speed]}`}
                defaultValue={settings.customTipSol ?? ""}
                onBlur={(e) => {
                  if (e.target.value.trim() === "") return update({ customTipSol: null });
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0 && v <= MAX_CUSTOM_FEE_SOL) update({ customTipSol: v });
                }}
              />
              <i>SOL</i>
            </span>
          </label>
          <label className="tm-set">
            <span>Buy buttons</span>
            <span className="tm-set-input">
              <input
                defaultValue={settings.buyPresets.join(", ")}
                onBlur={(e) => {
                  const list = e.target.value
                    .split(/[\s,]+/)
                    .map(Number)
                    .filter((n) => n >= MIN_TRADE_SOL && n <= 100)
                    .slice(0, BUY_PRESETS_PER_ROW * settings.buyRows);
                  if (list.length > 0) update({ buyPresets: list });
                }}
              />
              <i>SOL</i>
            </span>
          </label>
          <label
            className="tm-set tm-set-check"
            title="Keeps your trade away from validators known for sandwich attacks"
          >
            <input
              type="checkbox"
              checked={settings.mevProtect}
              onChange={(e) => update({ mevProtect: e.target.checked })}
            />
            <span>MEV shield</span>
          </label>
          <p className="small muted">{TRADE_LIMITS_TEXT}</p>
        </div>
      )}

      {status.kind !== "idle" && (
        <div className={`tm-trade-status ${status.kind}`} aria-live="polite">
          {status.kind === "busy" && (
            <>
              <StageSteps stage={status.stage} />
              <p className="small">
                <strong>{status.what}:</strong> {STAGE_TEXT[status.stage]}
                {status.quote ? <span className="muted"> {status.quote}</span> : null}
              </p>
            </>
          )}
          {status.kind === "done" && (
            <p className="small">
              <CheckIcon size={14} /> {status.text}{" "}
              <a href={`https://solscan.io/tx/${status.signature}`} target="_blank" rel="noreferrer">
                View on Solscan
              </a>
            </p>
          )}
          {status.kind === "error" && (
            <p className="small">
              {status.text}
              {status.signature && (
                <>
                  {" "}
                  <a href={`https://solscan.io/tx/${status.signature}`} target="_blank" rel="noreferrer">
                    Check it
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      )}

      <FeeExplainer
        fee={fee}
        swap={swapCosts}
        solUsd={solUsd}
        sizeSol={customLamports ? Number(customLamports) / LAMPORTS : (settings.buyPresets[0] ?? 0.1)}
      />

      {accepted && (
        <details className="small tm-trade-about">
          <summary>About trading here</summary>
          <p>{TRADE_DISCLAIMER}</p>
        </details>
      )}

      {sharing && summary && summary.pnlSol !== null && summary.pnlPct !== null && (
        <ShareImageDialog
          title={`${symbol ? `$${symbol}` : "Position"} PnL`}
          fileName={`trenchscanner-${symbol.replace(/[^a-z0-9]/gi, "").toLowerCase() || "token"}-pnl`}
          caption={`${symbol ? `$${symbol}` : "A token"} ${signedPct(summary.pnlPct * 100, 1)} with TrenchScanner`}
          link="trenchscanner.app"
          drawKey={shareAmounts ? "amounts" : "pct"}
          controls={
            <label className="small tm-share-opt">
              <input
                type="checkbox"
                checked={shareAmounts}
                onChange={(e) => setShareAmounts(e.target.checked)}
              />
              Show SOL amounts (off shows percentages only)
            </label>
          }
          render={() =>
            renderPositionCard({
              symbol: symbol || null,
              name,
              mintAddress: mint,
              open,
              pnlPct: summary.pnlPct!,
              pnlSol: summary.pnlSol!,
              solUsd,
              solIn: summary.solIn,
              solBack: summary.solOut + (summary.valueSol ?? 0),
              entryMcap: summary.entryMcap,
              nowMcap,
              showAmounts: shareAmounts,
            })
          }
          onClose={() => setSharing(false)}
        />
      )}
    </section>
  );
}
