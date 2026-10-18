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

/**
 * Pro Mode's Trade panel under the token modal's chart (user ask 2026-10-17): buy and sell the
 * coin with the signed-in wallet, and see the position - what it holds, what it paid, PnL. The
 * chart above it grows and marks the trades while this is open or the wallet holds the coin.
 *
 * No TrenchScanner fee. What a trade costs beyond the swap is the network's: a priority fee and
 * Helius Sender's tip (0.000005 SOL on Eco, 0.001 SOL on Turbo), shown under the buttons.
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

export function TradePanel({
  owner,
  mint,
  symbol,
  position,
  summary,
  onTraded,
  closeOnly = false,
  graceEndsAt = null,
}: {
  owner: string;
  mint: string;
  symbol: string;
  position: PositionResponse | null;
  summary: PositionSummary | null;
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
  const busy = status.kind === "busy";
  const balance = position ? BigInt(position.balance) : 0n;

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

  return (
    <section className="sage-card tm-trade" aria-label="Trade">
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
      {summary && (summary.held > 0 || summary.buys > 0 || summary.sells > 0) && (
        <div className="tm-trade-pos">
          <div className="tm-fig">
            <label>Holding</label>
            <span className="num">
              {tokensText(summary.held)} {symbol}
            </span>
            {summary.valueSol !== null && summary.held > 0 && (
              <small className="num muted">
                {solText(summary.valueSol)}
                {position?.solUsd ? ` · ${usd(summary.valueSol * position.solUsd)}` : ""}
              </small>
            )}
          </div>
          <div className="tm-fig">
            <label>Avg entry</label>
            <span className={summary.entryMcap ? "num" : "num none"}>
              {summary.entryMcap ? usd(summary.entryMcap) : "–"}
            </span>
            <small className="num muted">
              {solText(summary.solIn)} in · {solText(summary.solOut)} out
            </small>
          </div>
          <div className="tm-fig">
            <label>PnL</label>
            {summary.pnlSol !== null ? (
              <>
                <span className={`num ${summary.pnlSol >= 0 ? "up" : "down"}`}>
                  {solText(summary.pnlSol, true)}
                </span>
                <small className={`num delta ${summary.pnlSol >= 0 ? "up" : "down"}`}>
                  {signedPct((summary.pnlPct ?? 0) * 100, 1)}
                </small>
              </>
            ) : (
              <span className="num none">–</span>
            )}
          </div>
          <div className="tm-fig">
            <label>Trades</label>
            <span className="num">
              {summary.buys} buy{summary.buys === 1 ? "" : "s"} · {summary.sells} sell
              {summary.sells === 1 ? "" : "s"}
            </span>
            {position?.truncated && <small className="muted">older trades not counted</small>}
            {position?.historyUnavailable && <small className="muted">history unavailable just now</small>}
          </div>
        </div>
      )}

      {!accepted ? (
        <div className="tm-trade-disclaimer" role="note" aria-label="Before you trade">
          <p className="small">
            <strong>Before your first trade.</strong> {TRADE_DISCLAIMER}
          </p>
          <button
            className="small"
            onClick={() => {
              acceptDisclaimer(owner);
              setAccepted(true);
            }}
          >
            I understand
          </button>
        </div>
      ) : (
        <>
          {!closeOnly && (
            <div className="tm-trade-row" role="group" aria-label="Buy">
              <span className="tm-trade-label up">Buy</span>
              {settings.buyPresets.map((sol) => (
                <button
                  key={sol}
                  type="button"
                  className="tm-trade-btn buy"
                  disabled={busy}
                  onClick={() => trade("buy", BigInt(Math.round(sol * LAMPORTS)), `Buy ${solText(sol)}`)}
                >
                  {sol}
                </button>
              ))}
              <span className="tm-trade-custom">
                <input
                  inputMode="decimal"
                  placeholder="SOL"
                  aria-label="Buy amount in SOL"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && customLamports)
                      void trade("buy", customLamports, `Buy ${solText(Number(customLamports) / LAMPORTS)}`);
                  }}
                />
                <button
                  type="button"
                  className="tm-trade-btn buy"
                  disabled={busy || !customLamports}
                  onClick={() =>
                    customLamports &&
                    trade("buy", customLamports, `Buy ${solText(Number(customLamports) / LAMPORTS)}`)
                  }
                >
                  Buy
                </button>
              </span>
            </div>
          )}

          <div className="tm-trade-row" role="group" aria-label="Sell">
            <span className="tm-trade-label down">Sell</span>
            {settings.sellPresets.map((pct) => (
              <button
                key={pct}
                type="button"
                className="tm-trade-btn sell"
                disabled={busy || balance === 0n}
                title={balance === 0n ? "Nothing to sell" : undefined}
                onClick={() => trade("sell", shareOf(balance, pct), `Sell ${pct}%`, pct >= 100)}
              >
                {pct}%
              </button>
            ))}
            <button
              type="button"
              className={`ghost small tm-trade-turbo${settings.speed === "turbo" ? " on" : ""}`}
              aria-pressed={settings.speed === "turbo"}
              title="Turbo sends through every Helius path for the fastest landing, for a 0.001 SOL tip instead of 0.000005"
              onClick={() => update({ speed: settings.speed === "turbo" ? "eco" : "turbo" })}
            >
              Turbo {settings.speed === "turbo" ? "on" : "off"}
            </button>
            <button
              type="button"
              className="ghost small tm-trade-gear"
              aria-expanded={showSettings}
              onClick={() => setShowSettings(!showSettings)}
            >
              {settings.slippagePct}% slip
              {settings.priorityMode === "custom" ? " · custom fee" : ""}
              {settings.mevProtect ? " · MEV shield" : ""}
            </button>
          </div>
        </>
      )}

      {showSettings && (
        <div className="tm-trade-settings">
          <label>
            Slippage
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
            %
          </label>
          <span className="segmented small" role="radiogroup" aria-label="Speed">
            {(["eco", "turbo"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={settings.speed === s}
                className={settings.speed === s ? "on" : ""}
                title={
                  s === "eco"
                    ? "One fast path, a 0.000005 SOL tip"
                    : "Every Helius path, a 0.001 SOL tip: for launches where a slot matters"
                }
                onClick={() => update({ speed: s })}
              >
                {s === "eco" ? "Eco" : "Turbo"}
              </button>
            ))}
          </span>
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
                {m === "auto" ? "Auto fee" : "Custom fee"}
              </button>
            ))}
          </span>
          {settings.priorityMode === "custom" && (
            <label>
              Priority fee
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
              SOL
            </label>
          )}
          <label
            title={`At least ${MIN_TIP_SOL[settings.speed]} SOL on ${settings.speed === "turbo" ? "Turbo" : "Eco"}`}
          >
            Sender tip
            <input
              type="number"
              min={MIN_TIP_SOL[settings.speed]}
              max={MAX_CUSTOM_FEE_SOL}
              step={0.000001}
              placeholder={`${MIN_TIP_SOL[settings.speed]} (minimum)`}
              defaultValue={settings.customTipSol ?? ""}
              onBlur={(e) => {
                if (e.target.value.trim() === "") return update({ customTipSol: null });
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0 && v <= MAX_CUSTOM_FEE_SOL) update({ customTipSol: v });
              }}
            />
            SOL
          </label>
          <label title="Keeps your trade away from validators known for sandwich attacks">
            <input
              type="checkbox"
              checked={settings.mevProtect}
              onChange={(e) => update({ mevProtect: e.target.checked })}
            />
            MEV shield
          </label>
          <label>
            Buy buttons (SOL)
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
          </label>
        </div>
      )}

      <p className={`small tm-trade-status ${status.kind}`} aria-live="polite">
        {status.kind === "busy" &&
          `${status.what}: ${STAGE_TEXT[status.stage]}${status.quote ? ` ${status.quote}` : ""}`}
        {status.kind === "done" && (
          <>
            {status.text}{" "}
            <a href={`https://solscan.io/tx/${status.signature}`} target="_blank" rel="noreferrer">
              View
            </a>
          </>
        )}
        {status.kind === "error" && (
          <>
            {status.text}
            {status.signature && (
              <>
                {" "}
                <a href={`https://solscan.io/tx/${status.signature}`} target="_blank" rel="noreferrer">
                  Check it
                </a>
              </>
            )}
          </>
        )}
      </p>
      <p className="small tm-trade-fee" aria-live="polite">
        {fee ? (
          <>
            Expected network fee <strong className="num">{solText(feeTotalSol(fee))}</strong>
            <span className="muted num">
              {" "}
              (priority {solText(Number(fee.priorityFeeLamports) / LAMPORTS)} · Sender tip{" "}
              {solText(Number(fee.tipLamports) / LAMPORTS)} · base{" "}
              {solText(Number(fee.baseFeeLamports) / LAMPORTS)})
            </span>
            . This is a Solana blockchain fee, paid to the network.{" "}
          </>
        ) : (
          "Working out the network fee… "
        )}
        <strong>TrenchScanner platform fee: 0%.</strong>
      </p>
      {accepted && (
        <details className="small tm-trade-about">
          <summary>About trading here</summary>
          <p>{TRADE_DISCLAIMER}</p>
        </details>
      )}
    </section>
  );
}
