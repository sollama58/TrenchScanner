import { useState } from "react";
import { ApiError } from "../api";
import { signedPct, usd } from "../format";
import {
  graceLeftText,
  MAX_CUSTOM_FEE_SOL,
  MIN_TIP_SOL,
  readTradeSettings,
  acceptDisclaimer,
  disclaimerAccepted,
  useFeeEstimate,
  runTrade,
  saveTradeSettings,
  TradeError,
  type PositionResponse,
  type PositionSummary,
  type TradeSettings,
  type TradeStage,
} from "../proTrade";
import { WalletTimeoutError } from "../wallet";
import { renderPositionCard } from "../pnlCard";
import { BoltIcon, CheckIcon, GearIcon, ShareIcon, ShieldIcon } from "./Icons";
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

/** What a trade costs: the Solana network's fee, broken down, and TrenchScanner's 0%. */
function FeeExplainer({
  fee,
  solUsd,
}: {
  fee: { priorityFeeLamports: string; tipLamports: string; baseFeeLamports: string } | null;
  solUsd: number | null;
}) {
  const parts = fee
    ? [
        { key: "priority", label: "Priority fee", sol: Number(fee.priorityFeeLamports) / LAMPORTS },
        { key: "tip", label: "Helius Sender tip", sol: Number(fee.tipLamports) / LAMPORTS },
        { key: "base", label: "Base fee", sol: Number(fee.baseFeeLamports) / LAMPORTS },
      ]
    : [];
  const total = fee ? feeTotalSol(fee) : null;
  return (
    <div className="tm-fee" aria-live="polite">
      <div className="tm-fee-head">
        <span className="tm-fee-title">Expected fee per trade</span>
        <span className="tm-fee-total">
          {total !== null ? (
            <>
              <strong className="num">{solText(total)}</strong>
              {solUsd ? (
                <small className="num muted">
                  {" "}
                  ≈ ${(total * solUsd).toFixed(total * solUsd < 0.1 ? 3 : 2)}
                </small>
              ) : null}
            </>
          ) : (
            <span className="muted">Working it out…</span>
          )}
        </span>
      </div>
      {total !== null && total > 0 && (
        <div className="tm-fee-bar" aria-hidden="true">
          {parts.map((p) => (
            <span key={p.key} className={p.key} style={{ flexGrow: Math.max(p.sol / total, 0.03) }} />
          ))}
        </div>
      )}
      <ul className="tm-fee-rows">
        {parts.map((p) => (
          <li key={p.key}>
            <i className={`tm-fee-dot ${p.key}`} aria-hidden="true" />
            <span>{p.label}</span>
            <span className="num">{solText(p.sol)}</span>
          </li>
        ))}
        <li className="tm-fee-zero">
          <i className="tm-fee-dot zero" aria-hidden="true" />
          <span>TrenchScanner platform fee</span>
          <strong className="num">0%</strong>
        </li>
      </ul>
      <p className="tm-fee-note">
        The whole fee is a Solana blockchain fee, paid to the network and its validators.{" "}
        <strong>TrenchScanner takes nothing from your trade.</strong>
      </p>
    </div>
  );
}

/** A row of up to four preset buttons, two rows of three for five or six. */
function presetCols(n: number): React.CSSProperties {
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
  const [settings, setSettings] = useState<TradeSettings>(readTradeSettings);
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
    const next = { ...settings, ...patch };
    setSettings(next);
    saveTradeSettings(next);
  };

  const trade = async (side: "buy" | "sell", amount: bigint, what: string, all = false) => {
    if (busy || amount <= 0n || !accepted) return;
    // A big buy is one click from a preset or a typo: ask first.
    if (side === "buy" && amount >= CONFIRM_BUY_LAMPORTS && !window.confirm(`${what} of ${symbol}?`)) return;
    setStatus({ kind: "busy", stage: "building", what });
    try {
      const signature = await runTrade({ owner, mint, side, amount, all, settings }, (stage, built) =>
        setStatus({
          kind: "busy",
          stage,
          what,
          quote: built ? quoteText(built, side, position, symbol) : undefined,
        }),
      );
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
          confirmed in the top 250 $ASDFASDFA holders by then. You can still sell after that.
        </p>
      )}
      {closeOnly && (
        <p className="small tm-trade-warn">
          Pro Mode has ended for this wallet, so buying is off. You can still sell what you hold.
        </p>
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
              <div className="tm-presets" style={presetCols(settings.buyPresets.length)}>
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
            <div className="tm-presets" style={presetCols(settings.sellPresets.length)}>
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
                    .filter((n) => n > 0 && n <= 100)
                    .slice(0, 6);
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

      <FeeExplainer fee={fee} solUsd={solUsd} />

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
