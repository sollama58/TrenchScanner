import { useState } from "react";
import { ApiError } from "../api";
import { ago, minutes, signedPct, solUsdAgeText, usd } from "../format";
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
  expectedTokens,
  expectedSol,
  useSaleQuote,
  runTrade,
  saveTradeSettings,
  TradeError,
  tradeCooldownLeft,
  type FeeEstimate,
  type SwapCostEstimate,
  type PositionResponse,
  type PositionSummary,
  type TradeSettings,
  type TradeStage,
  MIN_TRADE_SOL,
  FEE_BASELINE_BPS,
  FEE_BASELINE_TEXT,
  feeSavedSol,
  sacrificeLine,
  type SacrificeView,
} from "../proTrade";
import { BurnUncertainError, describeBurnError, topUpBurnCredits } from "../burn";
import { WalletTimeoutError } from "../wallet";
import { decimalUnits, parseAmounts, parseDecimal } from "../decimal";
import { renderPositionCard } from "../pnlCard";
import {
  BoltIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  GearIcon,
  InfoIcon,
  ShareIcon,
  ShieldIcon,
} from "./Icons";
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
 *
 * Presets fill, they don't trade (user ask 2026-10-18): a buy button fills the SOL amount, a sell
 * button fills the token amount (any exact amount can be typed too), and the fee breakdown follows
 * the side last filled, so the cost reads before Buy or Sell is pressed.
 */

const LAMPORTS = 1_000_000_000;
/**
 * The trade limits the API enforces (proTrade.ts, user ask 2026-10-18), checked here first so the
 * panel can say so without a round trip: 0.01 SOL at least, one trade every 5 seconds per wallet,
 * and a sale of 100% (closing the position) exempt from both.
 */
const TRADE_LIMITS_TEXT = "Trades start at 0.01 SOL, one every 5 seconds. Selling 100% is always allowed.";

export function solText(sol: number, signed = false): string {
  const abs = Math.abs(sol);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : 6;
  const text = `${abs.toFixed(digits).replace(/\.?0+$/, "")} SOL`;
  return signed ? `${sol > 0 ? "+" : sol < 0 ? "-" : ""}${text}` : text;
}

/** Whole tokens, shortened: 1.23M, 456K, 12.3. */
export function tokensText(n: number): string {
  const abs = Math.abs(n);
  // Units picked on the rounded value, so 999,999 reads 1.00M and not 1000.0K.
  if (abs >= 999_995_000) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 999_950) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 999.995) return `${(n / 1e3).toFixed(1)}K`;
  if (n === 0) return "0";
  // A dust balance reads as a tiny number, not as "0.0000".
  return abs >= 1 ? n.toFixed(2) : abs >= 0.0001 ? n.toFixed(4) : n.toPrecision(2);
}

/** A typed SOL amount as lamports ("0.5" or "0,5"), or null when it isn't one. */
export function parseSol(text: string): bigint | null {
  const lamports = decimalUnits(text, 9, 6);
  return lamports !== null && lamports > 0n ? lamports : null;
}

/** A typed token amount in raw units at `decimals` ("1234.5" or "1234,5"), or null when it isn't one. */
export function parseTokens(text: string, decimals: number): bigint | null {
  const raw = decimalUnits(text, decimals, 20);
  return raw !== null && raw > 0n ? raw : null;
}

/** Raw token units as a plain decimal for an input, exact, no trailing zeros: "1234.5". */
export function unitsText(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const scale = 10n ** BigInt(decimals);
  const frac = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${raw / scale}.${frac}` : `${raw / scale}`;
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
  built: {
    quotedOut: string;
    minOut: string;
    priorityFeeLamports: string;
    tipLamports: string;
    sacrifice?: SacrificeView;
  },
  side: "buy" | "sell",
  position: { decimals: number | null } | null,
  symbol: string,
): string {
  // Network fees (priority fee, Sender tip, base fee); the Sacrifice, when it is on, is its own line.
  const fees =
    (Number(BigInt(built.priorityFeeLamports)) + Number(BigInt(built.tipLamports)) + 5_000) / LAMPORTS;
  const sacrifice = sacrificeLine(built.sacrifice);
  const tail = sacrifice
    ? `network fee ${solText(fees)}. ${sacrifice}`
    : `network fee ${solText(fees)}, no platform fee.`;
  if (side === "sell")
    return `About ${solText(Number(BigInt(built.quotedOut)) / LAMPORTS)}, at least ${solText(Number(BigInt(built.minOut)) / LAMPORTS)}; ${tail}`;
  const scale = 10 ** (position?.decimals ?? 6);
  return `About ${tokensText(Number(BigInt(built.quotedOut)) / scale)} ${symbol}, at least ${tokensText(Number(BigInt(built.minOut)) / scale)}; ${tail}`;
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
  | { kind: "error"; text: string; signature?: string }
  /** The Sacrifice is short of burned credits: one tap burns ASDF for them and retries. */
  | {
      kind: "topup";
      text: string;
      credits: number;
      raw: bigint;
      memo: string;
      retry: () => void;
      burning?: string;
    };

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
 * with TrenchScanner's own fee up top: 0%, or the Sacrifice (ASDF fee plan) once it is on. Sized on the amount in the box last filled (a buy's SOL, or a
 * sale's tokens priced at the position's value), or the first buy button.
 */
function FeeExplainer({
  fee,
  swap,
  solUsd,
  sizeSol,
  side = "buy",
  sizeLabel = null,
}: {
  fee: FeeEstimate | null;
  swap: SwapCostEstimate | null;
  solUsd: number | null;
  /** The trade's size in SOL: what a buy spends, or what a sale is worth (0 when unpriced). */
  sizeSol: number;
  side?: "buy" | "sell";
  /** A sale's size in tokens, "1.2M PEPE", for the heading. */
  sizeLabel?: string | null;
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
        // Rent is opening the token account, so only a buy pays it.
        ...(side === "buy" && Number(swap.accountRentLamports) > 0
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
  // The Sacrifice (ASDF fee plan): 0.2%, paid in burned credits, by wallets below the free
  // cut-off. Counted in the total only while it is on; in shadow it is shown as a preview.
  const sac = fee?.sacrifice && fee.sacrifice.mode !== "off" ? fee.sacrifice : null;
  const sacLine = sacrificeLine(sac, sizeSol > 0 ? sizeSol : undefined);
  const sacSol = sac?.pays && !sac.priceRefusal ? (sizeSol * sac.bps) / 10_000 : 0;
  const sacrificeParts =
    sac?.mode === "on" && sacSol > 0
      ? [{ key: "sacrifice", label: "Sacrifice (burned ASDF credits)", sol: sacSol, rate: bpsText(sac.bps) }]
      : [];
  const parts = [...network.map((p) => ({ ...p, rate: "" })), ...swapParts, ...sacrificeParts];
  const total = fee ? parts.reduce((sum, p) => sum + p.sol, 0) : null;
  // What this trade saves against a 1% platform fee elsewhere, less the Sacrifice when it's charged.
  const savedSol = sizeSol > 0 ? feeSavedSol(sizeSol, sac?.mode === "on" ? sacSol : 0) : 0;
  const usdText = (sol: number) => {
    const v = sol * (solUsd ?? 0);
    return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(v < 0.1 ? 3 : 2)}`;
  };
  return (
    <div className="tm-trade-fee" aria-live="polite">
      <div className="tm-fee-head">
        <span className="tm-fee-title">
          {side === "sell" && sizeLabel ? (
            <>
              Total cost of selling <span className="num">{sizeLabel}</span>
              {sizeSol > 0 && (
                <>
                  {" "}
                  (<span className="num">≈ {solText(sizeSol)}</span>)
                </>
              )}
            </>
          ) : (
            <>
              Total cost of a <span className="num">{solText(sizeSol)}</span> {side}
            </>
          )}
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
                  {sac?.pays ? (
                    <li>
                      <i className="tm-fee-dot sacrifice" aria-hidden="true" />
                      <span>
                        Sacrifice, in burned credits
                        <em className="num"> {bpsText(sac.bps)}</em>
                        {sac.mode === "shadow" && <em> (not charged yet)</em>}
                      </span>
                      <span className="num">{sacSol > 0 ? solText(sacSol) : "–"}</span>
                    </li>
                  ) : (
                    <li className="tm-fee-zero">
                      <i className="tm-fee-dot zero" aria-hidden="true" />
                      <span>TrenchScanner platform fee</span>
                      <strong className="num">0%</strong>
                    </li>
                  )}
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
      <div className="tm-fee-badges">
        {sac?.pays && sac.mode === "on" ? (
          <span className="tm-fee-sacrifice-badge">
            <strong>0.2% Sacrifice</strong>
            <span className="tm-fee-zero-more">
              paid in burned ASDF credits, free for the top {sac.freeRank} holders
            </span>
          </span>
        ) : (
          <span className="tm-fee-zero-badge">
            <CheckIcon size={12} />
            <strong>0% platform fee</strong>
            <span className="tm-fee-zero-more">
              {sac && !sac.pays && sac.reason === "holder"
                ? `free as a top ${sac.freeRank} holder`
                : "TrenchScanner takes nothing"}
            </span>
          </span>
        )}
        {savedSol > 0 && (
          <span
            className="tm-fee-saved"
            title={`What this trade saves against a ${FEE_BASELINE_BPS / 100}% platform fee (Axiom's), after any fee taken here`}
          >
            <span className="tm-fee-saved-label">Saves</span>
            <strong className="num">{solText(savedSol)}</strong>
            <span className="tm-fee-saved-vs">{FEE_BASELINE_TEXT}</span>
          </span>
        )}
      </div>
      {sacLine && <p className="small muted tm-fee-sacrifice-line">{sacLine}</p>}
    </div>
  );
}

/** A row of up to four preset buttons, two rows of three for five or six. */
/** The buy buttons' grid: every button in one row, or split over two (Settings > Trading). */
export function presetCols(n: number, rows: 1 | 2 = 1): React.CSSProperties {
  return { "--cols": Math.max(rows === 2 ? Math.ceil(n / 2) : n, 1) } as React.CSSProperties;
}

/** The sell buttons keep their old grid: up to four in a row. */
export function sellCols(n: number): React.CSSProperties {
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
  positionStaleAt = null,
  summary,
  nowMcap = null,
  nowMcapAt = null,
  onTraded,
  closeOnly = false,
  graceEndsAt = null,
  buyOnly = false,
  hidePosition = false,
  maxBuySol = null,
  delayed = false,
}: {
  owner: string;
  mint: string;
  symbol: string;
  name?: string | null;
  position: PositionResponse | null;
  /** The last refresh of the position failed: when the one shown was read (ms). Null: it is current. */
  positionStaleAt?: number | null;
  summary: PositionSummary | null;
  /** The coin's market cap now (USD), for the holdings and the share card. */
  nowMcap?: number | null;
  /** When nowMcap was read (ms), for the share card's time. */
  nowMcapAt?: number | null;
  onTraded: () => void;
  /** Pro Mode has ended: selling what it holds only (closing a position is always allowed). */
  closeOnly?: boolean;
  /** Out of the top 250 holders: when Pro Mode ends (ms). */
  graceEndsAt?: number | null;
  /** Buying only, no Sell side: the $ASDFASDFA buy for a wallet without Pro Mode (BuyAsdfDialog). */
  buyOnly?: boolean;
  /** No position block (the Buy $ASDFASDFA popup, user ask 2026-10-18). */
  hidePosition?: boolean;
  /** The most one buy may spend here; null: no cap. */
  maxBuySol?: number | null;
  /**
   * The coin isn't getting instant updates (TokenModal's delayed chart): a one-line note says the
   * figures may be behind while trades are priced live (user ask 2026-10-18: open, and minimal).
   */
  delayed?: boolean;
}) {
  // Shared with Settings > Trading: a change there shows here at once, and the other way round.
  const settings = useTradeSettings();
  const [custom, setCustom] = useState("");
  const [sellText, setSellText] = useState("");
  // The side last filled or typed in: the fee breakdown sizes on it.
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showSettings, setShowSettings] = useState(false);
  const [accepted, setAccepted] = useState(() => disclaimerAccepted(owner));
  const [sharing, setSharing] = useState(false);
  const [shareAmounts, setShareAmounts] = useState(true);
  const busy = status.kind === "busy";
  const balance = position ? BigInt(position.balance) : 0n;
  const solUsd = position?.solUsd ?? null;
  // The SOL price is kept through failed reads: dollar figures say so once it is a while old.
  const solPriceAge = solUsdAgeText(position?.solUsdAt);

  const update = (patch: Partial<TradeSettings>) => {
    saveTradeSettings({ ...settings, ...patch });
  };

  const trade = async (side: "buy" | "sell", amount: bigint, what: string, all = false) => {
    if (busy || amount <= 0n || !accepted) return;
    const refuse = (text: string) => setStatus({ kind: "error", text });
    if (!all) {
      if (side === "buy" && amount < BigInt(Math.round(MIN_TRADE_SOL * LAMPORTS)))
        return refuse("The smallest buy is 0.01 SOL.");
      if (side === "buy" && maxBuySol !== null && amount > BigInt(Math.round(maxBuySol * LAMPORTS)))
        return refuse(`Buy up to ${maxBuySol} SOL at a time here.`);
      const worth =
        side === "sell" && summary?.valueSol != null && balance > 0n
          ? (summary.valueSol * Number(amount)) / Number(balance)
          : null;
      if (worth !== null && worth < MIN_TRADE_SOL)
        return refuse(
          "That sale is worth under 0.01 SOL, the smallest trade. Sell 100% to close the position.",
        );
      const left = tradeCooldownLeft(owner);
      if (left > 0) return refuse(`One trade every 5 seconds: try again in ${Math.ceil(left / 1_000)}s.`);
    }
    // A big buy is one click from a preset or a typo: ask first, with its Sacrifice when it pays one.
    // A sale's SOL value is the position's share; the two-factor prompt shows the same line.
    const sizeSol =
      side === "buy"
        ? Number(amount) / LAMPORTS
        : summary?.valueSol != null && balance > 0n
          ? (summary.valueSol * Number(amount)) / Number(balance)
          : undefined;
    // An unpriced sale shows its tier only: the fee read's figure is for another amount.
    const sacrificeNote =
      sizeSol !== undefined || !fee?.sacrifice?.pays ? sacrificeLine(fee?.sacrifice, sizeSol) : null;
    if (
      side === "buy" &&
      amount >= CONFIRM_BUY_LAMPORTS &&
      !window.confirm(`${what} of ${symbol}?${sacrificeNote ? `\n\n${sacrificeNote}` : ""}`)
    )
      return;
    setStatus({ kind: "busy", stage: "building", what });
    try {
      const signature = await runTrade(
        { owner, mint, side, amount, all, settings, sacrificeNote },
        (stage, built) => {
          setStatus({
            kind: "busy",
            stage,
            what,
            quote: built ? quoteText(built, side, position, symbol) : undefined,
          });
        },
      );
      setStatus({ kind: "done", text: `${what}: confirmed.`, signature });
      // The balance has moved, so a filled sale amount is stale.
      if (side === "sell") setSellText("");
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as Record<string, unknown> | null) : null;
      if (body?.topUp === true && typeof body.topUpRaw === "string" && typeof body.memo === "string") {
        setStatus({
          kind: "topup",
          text: errorText(e),
          credits: typeof body.needCredits === "number" ? body.needCredits : 0,
          raw: BigInt(body.topUpRaw),
          memo: body.memo,
          retry: () => void trade(side, amount, what, all),
        });
        return;
      }
      setStatus({
        kind: "error",
        text: errorText(e),
        signature: e instanceof TradeError ? e.signature : undefined,
      });
    } finally {
      onTraded();
    }
  };

  /** Burns ASDF for the credits the Sacrifice is short of, then tries the trade again. */
  const topUp = async (s: Extract<Status, { kind: "topup" }>) => {
    if (s.burning) return;
    setStatus({ ...s, burning: "Burning ASDF for credits…" });
    try {
      await topUpBurnCredits(owner, s.raw, s.memo, (stage) =>
        setStatus({
          ...s,
          burning: stage === "signing" ? "Approve the burn in your wallet…" : "Burning ASDF for credits…",
        }),
      );
      setStatus({ kind: "idle" });
      s.retry();
    } catch (e) {
      setStatus({
        kind: "error",
        text: e instanceof BurnUncertainError ? e.message : describeBurnError(e, "Your wallet"),
        signature: e instanceof BurnUncertainError ? e.signature : undefined,
      });
    }
  };

  const customLamports = parseSol(custom);
  const fee = useFeeEstimate(mint, settings);
  // Quoted on the amount the buy is set to (a preset fills it), else the first preset.
  const swapCosts = useSwapCosts(
    mint,
    customLamports ? Number(customLamports) / LAMPORTS : (settings.buyPresets[0] ?? 0.1),
  );
  const coinDecimals = position?.decimals ?? null;
  const supplyCoins =
    position?.supply && coinDecimals !== null ? Number(BigInt(position.supply)) / 10 ** coinDecimals : null;
  const coinPriceSol = nowMcap && supplyCoins && solUsd ? nowMcap / supplyCoins / solUsd : null;
  const expected = expectedTokens(customLamports, swapCosts, coinPriceSol);
  const hasPosition = !!summary && (summary.held > 0 || summary.buys > 0 || summary.sells > 0);
  const open = !!summary && summary.held > 0;
  const tone = summary?.pnlSol == null ? "" : summary.pnlSol >= 0 ? "up" : "down";
  const canShare = !!summary && summary.pnlSol !== null && summary.pnlPct !== null;
  const buyCustom = () =>
    customLamports && void trade("buy", customLamports, `Buy ${solText(Number(customLamports) / LAMPORTS)}`);
  // Exact token amounts need the coin's decimals; without them the field stays off.
  const decimals = position?.decimals ?? null;
  const sellUnits = decimals !== null ? parseTokens(sellText, decimals) : null;
  const sellTooMuch = sellUnits !== null && sellUnits > balance;
  const sellTokens = sellUnits !== null && decimals !== null ? Number(sellUnits) / 10 ** decimals : null;
  const sellWorthSol =
    sellUnits !== null && !sellTooMuch && summary?.valueSol != null && balance > 0n
      ? (summary.valueSol * Number(sellUnits)) / Number(balance)
      : null;
  // The SOL the sale would get, by the route's quote into SOL whatever the coin's pair (PUMP, USDC).
  const saleQuote = useSaleQuote(buyOnly ? null : mint, sellTooMuch ? null : sellUnits);
  const expectedOut = sellTooMuch ? null : expectedSol(sellUnits, saleQuote, sellWorthSol);
  const sellCustom = () => {
    if (sellUnits === null || sellTooMuch || sellTokens === null) return;
    const all = sellUnits === balance;
    void trade(
      "sell",
      sellUnits,
      all ? `Sell all ${symbol}`.trim() : `Sell ${tokensText(sellTokens)} ${symbol}`.trim(),
      all,
    );
  };

  const title = (
    <>
      <BoltIcon size={14} /> Trade{symbol ? ` $${symbol}` : ""}
    </>
  );
  return (
    <section className="sage-card tm-trade" aria-label="Trade">
      <header className="tm-trade-head">
        <h4>{title}</h4>
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

      {delayed && (
        <p
          className="muted small tm-trade-delay"
          role="note"
          title="The chart and figures here may be behind; your trade is priced at the coin's current on-chain price, within your slippage."
        >
          <ClockIcon size={11} /> Delayed chart · trades priced live
        </p>
      )}
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

      {!hidePosition && hasPosition && summary && (
        <div className={`tm-hold ${tone}${positionStaleAt !== null ? " stale" : ""}`}>
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
              {open && summary.sells > 0 && summary.realizedSol !== null && (
                <small
                  className="muted num tm-hold-split"
                  title="Realized: what your sales made over what those coins cost. Unrealized: the coins you still hold at today's value, against what they cost. Fees included."
                >
                  {solText(summary.realizedSol, true)} realized
                  {summary.unrealizedSol !== null
                    ? ` · ${solText(summary.unrealizedSol, true)} unrealized`
                    : ""}
                </small>
              )}
            </div>
            <button
              type="button"
              className="tm-hold-share"
              disabled={!canShare}
              aria-label="Share PnL"
              title={
                canShare
                  ? "Share this position as an image (your wallet is never on it)"
                  : "Nothing to share yet"
              }
              onClick={() => setSharing(true)}
            >
              <ShareIcon size={14} />
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
            {open ? (
              // Where the coins still held bring the whole position back to even (user ask 2026-10-19).
              <Stat
                label="Break-even"
                value={
                  summary.breakEvenMcap === null
                    ? "–"
                    : summary.breakEvenMcap === 0
                      ? "Covered"
                      : usd(summary.breakEvenMcap)
                }
                sub={
                  summary.breakEvenMcap === 0
                    ? "sales paid it back"
                    : summary.breakEvenMcap !== null && nowMcap
                      ? `${signedPct((summary.breakEvenMcap / nowMcap - 1) * 100, 0)} from now`
                      : undefined
                }
              />
            ) : (
              <Stat
                label="Held"
                value={
                  summary.firstAt !== null && summary.lastAt !== null
                    ? minutes((summary.lastAt - summary.firstAt) / 60_000)
                    : "–"
                }
                sub={`${summary.buys} buy${summary.buys === 1 ? "" : "s"} · ${summary.sells} sell${summary.sells === 1 ? "" : "s"}`}
              />
            )}
          </div>
          {position?.historyUnavailable && (
            <p className="small muted tm-hold-note">Trade history is unavailable just now.</p>
          )}
          {positionStaleAt !== null && (
            <p className="small muted tm-hold-note">
              Couldn&apos;t refresh your position, showing it as read {ago(new Date(positionStaleAt))}.
            </p>
          )}
          {solPriceAge && (
            <p className="small muted tm-hold-note">Dollar figures use a SOL price from {solPriceAge}.</p>
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
      ) : closeOnly ? null : (
        // Pro Mode ended: no buttons at all, since the API refuses sells too (#717).
        <div className={`tm-trade-sides${buyOnly ? " one" : ""}`}>
          {
            <div className="tm-side buy" role="group" aria-label="Buy">
              <div className="tm-side-head">
                <span className="tm-side-title">Buy</span>
                <span className="muted small">with SOL</span>
              </div>
              <div className="tm-presets" style={presetCols(settings.buyPresets.length, settings.buyRows)}>
                {settings.buyPresets.map((sol, i) => (
                  <button
                    key={`${sol}-${i}`}
                    type="button"
                    className={`tm-preset${customLamports === BigInt(Math.round(sol * LAMPORTS)) ? " on" : ""}`}
                    aria-pressed={customLamports === BigInt(Math.round(sol * LAMPORTS))}
                    disabled={busy || (maxBuySol !== null && sol > maxBuySol)}
                    title={
                      maxBuySol !== null && sol > maxBuySol ? `Up to ${maxBuySol} SOL a buy here` : undefined
                    }
                    onClick={() => {
                      setCustom(String(sol));
                      setSide("buy");
                    }}
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
                    onChange={(e) => {
                      setCustom(e.target.value);
                      setSide("buy");
                    }}
                    onFocus={() => setSide("buy")}
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
              {expected && (
                <p
                  className="small muted num tm-expect"
                  title={
                    expected.quoted
                      ? "What this buy would get at the route's price now, before slippage"
                      : "An estimate at the latest price; the exact quote follows in a moment"
                  }
                >
                  ≈ {tokensText(expected.tokens)} {symbol}
                  {expected.quoted ? "" : " (est.)"}
                </p>
              )}
            </div>
          }
          {!buyOnly && (
            <div className="tm-side sell" role="group" aria-label="Sell">
              <div className="tm-side-head">
                <span className="tm-side-title">Sell</span>
                <span className="muted small num">
                  {balance > 0n && summary ? `${tokensText(summary.held)} ${symbol} held` : "nothing held"}
                </span>
              </div>
              <div className="tm-presets" style={sellCols(settings.sellPresets.length)}>
                {settings.sellPresets.map((pct, i) => (
                  <button
                    key={`${pct}-${i}`}
                    type="button"
                    className={`tm-preset${balance > 0n && sellUnits === shareOf(balance, pct) ? " on" : ""}`}
                    aria-pressed={balance > 0n && sellUnits === shareOf(balance, pct)}
                    disabled={busy || balance === 0n || decimals === null}
                    title={balance === 0n ? "Nothing to sell" : undefined}
                    onClick={() => {
                      if (decimals === null) return;
                      setSellText(unitsText(shareOf(balance, pct), decimals));
                      setSide("sell");
                    }}
                  >
                    <span className="num">{pct}%</span>
                    {pct >= 100 && <small>all</small>}
                  </button>
                ))}
              </div>
              <div className="tm-amount">
                <span className="tm-amount-field">
                  <input
                    inputMode="decimal"
                    placeholder="Amount"
                    aria-label={`Sell amount in ${symbol || "tokens"}`}
                    aria-invalid={sellTooMuch || undefined}
                    disabled={balance === 0n || decimals === null}
                    value={sellText}
                    onChange={(e) => {
                      setSellText(e.target.value);
                      setSide("sell");
                    }}
                    onFocus={() => setSide("sell")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") sellCustom();
                    }}
                  />
                  <span className="tm-amount-unit">{symbol || "tokens"}</span>
                </span>
                <button
                  type="button"
                  className="tm-go sell"
                  disabled={busy || sellUnits === null || sellTooMuch}
                  onClick={sellCustom}
                >
                  Sell
                </button>
              </div>
              {sellTooMuch && <p className="small tm-amount-note">That&apos;s more than you hold.</p>}
              {expectedOut && (
                <p
                  className="small muted num tm-expect"
                  title={
                    expectedOut.quoted
                      ? "What this sale would get at the route's price now, before slippage"
                      : "An estimate at the latest price; the exact quote follows in a moment"
                  }
                >
                  ≈ {solText(expectedOut.sol)}
                  {expectedOut.quoted ? "" : " (est.)"}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {showSettings && (
        <div className="tm-trade-settings">
          <label className="tm-set">
            <span>Slippage</span>
            <span className="tm-set-input">
              <input
                inputMode="decimal"
                autoComplete="off"
                defaultValue={settings.slippagePct}
                // On blur, like the fields below: checked on every keystroke, "0.5" could never be
                // typed (its "0" was refused) and the field couldn't be cleared. Text, not a number
                // field, so "0,5" works too (decimal.ts).
                onBlur={(e) => {
                  const v = parseDecimal(e.target.value);
                  if (v !== null && v >= 0.1 && v <= 50) update({ slippagePct: v });
                  e.target.value = String(v !== null && v >= 0.1 && v <= 50 ? v : settings.slippagePct);
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
                  inputMode="decimal"
                  autoComplete="off"
                  defaultValue={settings.customPrioritySol}
                  onBlur={(e) => {
                    const v = parseDecimal(e.target.value);
                    const ok = v !== null && v >= 0 && v <= MAX_CUSTOM_FEE_SOL;
                    if (ok) update({ customPrioritySol: v });
                    e.target.value = String(ok ? v : settings.customPrioritySol);
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
                inputMode="decimal"
                autoComplete="off"
                placeholder={`${MIN_TIP_SOL[settings.speed]}`}
                defaultValue={settings.customTipSol ?? ""}
                onBlur={(e) => {
                  if (e.target.value.trim() === "") return update({ customTipSol: null });
                  const v = parseDecimal(e.target.value);
                  const ok = v !== null && v > 0 && v <= MAX_CUSTOM_FEE_SOL;
                  if (ok) update({ customTipSol: v });
                  e.target.value = ok
                    ? String(v)
                    : settings.customTipSol === null
                      ? ""
                      : String(settings.customTipSol);
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
                  const list = parseAmounts(
                    e.target.value,
                    100,
                    BUY_PRESETS_PER_ROW * settings.buyRows,
                    MIN_TRADE_SOL,
                  );
                  if (list.length > 0) update({ buyPresets: list });
                  e.target.value = (list.length > 0 ? list : settings.buyPresets).join(", ");
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
          {status.kind === "topup" && (
            <>
              <p className="small">{status.text}</p>
              <button
                type="button"
                className="primary small"
                disabled={!!status.burning}
                onClick={() => void topUp(status)}
              >
                {status.burning ??
                  `Burn ASDF for ${status.credits} credit${status.credits === 1 ? "" : "s"} and trade`}
              </button>
            </>
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
        {...(side === "sell" && !buyOnly && sellTokens !== null && !sellTooMuch
          ? {
              side: "sell" as const,
              sizeSol: sellWorthSol ?? 0,
              sizeLabel: `${tokensText(sellTokens)} ${symbol}`.trim(),
            }
          : {
              side: "buy" as const,
              sizeSol: customLamports ? Number(customLamports) / LAMPORTS : (settings.buyPresets[0] ?? 0.1),
            })}
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
              solIn: summary.investedSol,
              solBack: summary.investedSol + summary.pnlSol!,
              entryMcap: summary.entryMcap,
              nowMcap,
              nowMcapAt,
              feesSavedSol: summary.feesSavedSol,
              showAmounts: shareAmounts,
            })
          }
          onClose={() => setSharing(false)}
        />
      )}
    </section>
  );
}
