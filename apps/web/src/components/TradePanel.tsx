import { useState } from "react";
import { ApiError } from "../api";
import { signedPct, usd } from "../format";
import {
  readTradeSettings,
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

const STAGE_TEXT: Record<TradeStage, string> = {
  building: "Building and checking the trade…",
  signing: "Approve it in your wallet…",
  sending: "Sending through Helius Sender…",
  confirming: "Waiting for the chain to confirm…",
};

type Status =
  | { kind: "idle" }
  | { kind: "busy"; stage: TradeStage; what: string }
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
}: {
  owner: string;
  mint: string;
  symbol: string;
  position: PositionResponse | null;
  summary: PositionSummary | null;
  onTraded: () => void;
}) {
  const [settings, setSettings] = useState<TradeSettings>(readTradeSettings);
  const [custom, setCustom] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showSettings, setShowSettings] = useState(false);
  const busy = status.kind === "busy";
  const balance = position ? BigInt(position.balance) : 0n;

  const update = (patch: Partial<TradeSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveTradeSettings(next);
  };

  const trade = async (side: "buy" | "sell", amount: bigint, what: string) => {
    if (busy || amount <= 0n) return;
    setStatus({ kind: "busy", stage: "building", what });
    try {
      const signature = await runTrade({ owner, mint, side, amount, settings }, (stage) =>
        setStatus({ kind: "busy", stage, what }),
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
  const tip = settings.speed === "turbo" ? 0.001 : 0.000005;

  return (
    <section className="sage-card tm-trade" aria-label="Trade">
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

      <div className="tm-trade-row" role="group" aria-label="Sell">
        <span className="tm-trade-label down">Sell</span>
        {settings.sellPresets.map((pct) => (
          <button
            key={pct}
            type="button"
            className="tm-trade-btn sell"
            disabled={busy || balance === 0n}
            title={balance === 0n ? "Nothing to sell" : undefined}
            onClick={() => trade("sell", shareOf(balance, pct), `Sell ${pct}%`)}
          >
            {pct}%
          </button>
        ))}
        <button
          type="button"
          className="ghost small tm-trade-gear"
          aria-expanded={showSettings}
          onClick={() => setShowSettings(!showSettings)}
        >
          {settings.slippagePct}% slip · {settings.speed === "turbo" ? "Turbo" : "Eco"}
          {settings.mevProtect ? " · MEV shield" : ""}
        </button>
      </div>

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
        {status.kind === "busy" && `${status.what}: ${STAGE_TEXT[status.stage]}`}
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
        {status.kind === "idle" &&
          `No TrenchScanner fee. Each trade pays the network about ${solText(tip + 0.00001)} (Sender tip and priority fee).`}
      </p>
    </section>
  );
}
