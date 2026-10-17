import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { confirmedTradingCall } from "../tradeConfirm";
import {
  BoltIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  ExternalIcon,
  LockIcon,
  RobotIcon,
} from "../components/Icons";
import { Skeleton } from "../components/Charts";
import { useNow } from "../hooks";
import { ago, shortAddress } from "../format";

/**
 * The trading bot (admin-only while it is new). A wallet the server holds for you - its key sealed
 * under AWS KMS, never sent to the browser - buys the signals of the filters and models you pick
 * and sells them on an exit plan (the project's default, or your own). Withdrawals only ever go
 * to the wallet you signed in with. See packages/core/src/trading.
 */

interface TakeProfit {
  multiple: number;
  sellFraction: number;
}
interface TrailTier {
  fromMultiple: number;
  fraction: number;
}
interface ExitPlan {
  takeProfits: TakeProfit[];
  stopFraction: number;
  maxHoldMinutes: number;
  trail: TrailTier[];
  trailMaxHoldMinutes: number;
}
interface BotConfig {
  sources: {
    filterIds: string[];
    models: string[];
    highConvictionOnly: boolean;
    requireAiBuy: boolean;
    minAiProbability2x: number;
  };
  buySol: number;
  maxOpenPositions: number;
  maxDailySpendSol: number;
  maxSignalAgeSeconds: number;
  slippageBps: number;
  exitSlippageBps: number;
  exitSlippageMaxBps: number;
  maxEntryTries: number;
  maxPriorityFeeSol: number;
  jitoTipSol: number;
  reserveSol: number;
  dailyLossLimitSol: number;
  notifyTelegram: boolean;
  exitPlan: ExitPlan | null;
  /** Paper strategies only: bps taken off each simulated fill. */
  fillPenaltyBps?: number;
}
/** The server's optional ceilings: null where it sets none (the default). */
interface Ceilings {
  maxBuySol: number | null;
  maxDailySpendSol: number | null;
  maxSlippageBps: number | null;
  /** Exits' own slippage ceiling (TRADING_MAX_EXIT_SLIPPAGE_BPS); absent from older API builds. */
  maxExitSlippageBps?: number | null;
  maxPriorityFeeSol: number | null;
}
interface Position {
  id: string;
  mint: string;
  symbol: string | null;
  source: string;
  status: "buying" | "open" | "stuck" | "closed" | "failed";
  entryLamports: string | null;
  proceedsLamports: string | null;
  tokensHeld: string;
  tokensBought: string | null;
  lastMultiple: number | null;
  highMultiple: number | null;
  rungsTaken: number;
  openedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  closeRequested: boolean;
  error: string | null;
  createdAt?: string;
  signalAt: string;
  exitPlanSummary: string;
}
interface Withdrawal {
  id: string;
  sentLamports: string | null;
  requestedLamports: string | null;
  status: string;
  signature: string | null;
  error: string | null;
  createdAt: string;
}
type Scope = "own" | "server";

interface TradingState {
  scope: Scope;
  canTrade: boolean;
  /** For admins: whether the server wallet is set up (its tab shows then). */
  serverWallet: { configured: boolean } | null;
  keyProviderReady: boolean;
  keyProviderProblem: string | null;
  withdrawTo: string | null;
  wallet: { publicKey: string; createdAt: string | null; balanceLamports: string | null } | null;
  bot: {
    enabled: boolean;
    config: BotConfig;
    lastRunAt: string | null;
    lastError: string | null;
    exitPlanSummary: string;
  };
  defaults: Ceilings & {
    exitPlan: ExitPlan;
    exitPlanSummary: string;
  };
  sources: {
    filters: { id: string; name: string; isActive: boolean; changedSinceSaved: boolean }[];
    models: { id: string; name: string }[];
  };
  positions: Position[];
  withdrawals: Withdrawal[];
}

/** GET /trading/status: whether the bot runs here, what it is missing, and the limits it runs under. */
interface TradingStatus {
  enabled: boolean;
  checks: { id: string; label: string; ok: boolean; detail: string }[];
  limits: Ceilings;
  defaults: BotConfig;
  exitPlanSummary: string;
  models: { id: string; name: string }[];
  pumpPortalFallback: boolean;
}

const LAMPORTS = 1_000_000_000;
const ceiling = (v: number | null, unit: string) => (v === null ? "No limit" : `${v}${unit}`);
const sol = (lamports: string | null | undefined, digits = 4) =>
  lamports === null || lamports === undefined ? "–" : `${(Number(lamports) / LAMPORTS).toFixed(digits)} SOL`;
const solscan = (kind: "account" | "tx" | "token", id: string) => `https://solscan.io/${kind}/${id}`;
/** The API routes for a scope: your own wallet, or the server wallet. */
const base = (scope: Scope) => (scope === "server" ? "/trading/server" : "/trading");
const SCOPE_KEY = "trading-scope";
function storedScope(): Scope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "server" ? "server" : "own";
  } catch {
    return "own";
  }
}
const errorText = (err: unknown) =>
  err instanceof ApiError && typeof (err.body as { error?: unknown })?.error === "string"
    ? (err.body as { error: string }).error
    : String(err instanceof Error ? err.message : err);

export function TradingTab() {
  const [status, setStatus] = useState<TradingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<TradingStatus>("/trading/status")
      .then(setStatus)
      .catch((err: unknown) => setError(errorText(err)));
  }, []);
  if (error) {
    return (
      <div className="stack">
        <p className="notice small">{error}</p>
      </div>
    );
  }
  if (!status) {
    return (
      <section className="panel">
        <Skeleton lines={4} />
      </section>
    );
  }
  return status.enabled ? <TradingConsole /> : <BotOff status={status} />;
}

/**
 * The tab while TRADING_BOT_ENABLED is off: read-only. The api has no wallet, bot, sell or
 * withdrawal routes then and the trader runs nothing, so this shows what turning it on needs and
 * the limits it would run under, with nothing to press.
 */
function BotOff({ status }: { status: TradingStatus }) {
  const d = status.defaults;
  const l = status.limits;
  return (
    <div className="stack trading">
      <section className="panel">
        <header className="section-head">
          <div>
            <span className="eyebrow">
              <RobotIcon size={13} /> Trading bot
            </span>
            <h2>Off</h2>
            <p className="muted small">
              Switched off on this deployment (TRADING_BOT_ENABLED=false). It holds no wallets, places no
              trades and moves no funds. Turning it on is a deploy setting, not a button here.
            </p>
          </div>
        </header>
        <dl className="facts">
          {status.checks.map((c) => (
            <div key={c.id}>
              <dt>
                {c.ok ? <CheckIcon size={12} /> : <CloseIcon size={12} />} {c.label}
              </dt>
              <dd className="small" style={{ overflowWrap: "anywhere" }}>
                {c.detail}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="panel">
        <header className="section-head">
          <div>
            <span className="eyebrow">
              <LockIcon size={13} /> Limits it would run under
            </span>
            <h2>Server ceilings</h2>
            <p className="muted small">
              None by default but exit slippage: each admin sets their own bot&apos;s limits. A TRADING_MAX_*
              setting on the server adds a ceiling no bot can pass.
            </p>
          </div>
        </header>
        <dl className="facts">
          <div>
            <dt>Largest buy</dt>
            <dd className="num">{ceiling(l.maxBuySol, " SOL")}</dd>
          </div>
          <div>
            <dt>Spend per 24 hours</dt>
            <dd className="num">{ceiling(l.maxDailySpendSol, " SOL")}</dd>
          </div>
          <div>
            <dt>Entry slippage</dt>
            <dd className="num">{ceiling(l.maxSlippageBps === null ? null : l.maxSlippageBps / 100, "%")}</dd>
          </div>
          <div>
            <dt>Exit slippage</dt>
            <dd className="num">
              {ceiling(l.maxExitSlippageBps == null ? null : l.maxExitSlippageBps / 100, "%")}
            </dd>
          </div>
          <div>
            <dt>Priority fee per swap</dt>
            <dd className="num">{ceiling(l.maxPriorityFeeSol, " SOL")}</dd>
          </div>
        </dl>
      </section>
      <section className="panel">
        <header className="section-head">
          <div>
            <span className="eyebrow">
              <BoltIcon size={13} /> A new bot&apos;s settings
            </span>
            <h2>Defaults</h2>
            <p className="muted small">
              Each admin&apos;s bot starts paused, following nothing, with these settings to edit once it is
              on.
            </p>
          </div>
        </header>
        <dl className="facts">
          <div>
            <dt>Buy size</dt>
            <dd className="num">{d.buySol} SOL</dd>
          </div>
          <div>
            <dt>Open positions at once</dt>
            <dd className="num">{d.maxOpenPositions}</dd>
          </div>
          <div>
            <dt>Spend per 24 hours</dt>
            <dd className="num">{d.maxDailySpendSol} SOL</dd>
          </div>
          <div>
            <dt>Oldest signal it buys</dt>
            <dd className="num">{d.maxSignalAgeSeconds}s</dd>
          </div>
          <div>
            <dt>Slippage</dt>
            <dd className="num">{d.slippageBps / 100}%</dd>
          </div>
          <div>
            <dt>SOL kept back</dt>
            <dd className="num">{d.reserveSol} SOL</dd>
          </div>
          <div>
            <dt>Exit plan</dt>
            <dd className="small">{status.exitPlanSummary}</dd>
          </div>
          <div>
            <dt>Sends through</dt>
            <dd className="small">{d.jitoTipSol > 0 ? `Jito, ${d.jitoTipSol} SOL tip` : "the RPC"}</dd>
          </div>
          <div>
            <dt>AI judge</dt>
            <dd className="small">
              {d.sources.requireAiBuy ? "Buys only on its buy verdict" : "Not consulted"}
            </dd>
          </div>
          <div>
            <dt>Models it can follow</dt>
            <dd className="small">{status.models.map((m) => m.name).join(", ") || "none"}</dd>
          </div>
        </dl>
      </section>
      <TradeAlertsPanel />
      <PaperPanel />
      <BacktestPanel />
    </div>
  );
}

function TradingConsole() {
  const [scope, setScopeState] = useState<Scope>(storedScope);
  const [state, setState] = useState<TradingState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The scope shown now: a response for the other one, still in flight at a switch, is dropped.
  const scopeRef = useRef(scope);
  const setScope = (next: Scope) => {
    scopeRef.current = next;
    setScopeState(next);
    setState(null);
    try {
      localStorage.setItem(SCOPE_KEY, next);
    } catch {
      /* a convenience only */
    }
  };

  const reload = useCallback(async () => {
    try {
      const res = await api<TradingState>(base(scope));
      if (scopeRef.current !== scope) return;
      setState(res);
      setLoadError(null);
    } catch (err) {
      if (scopeRef.current !== scope) return;
      // The server wallet is for admins: anyone else lands back on their own.
      if (scope === "server" && err instanceof ApiError && err.status === 403) return setScope("own");
      setLoadError(
        err instanceof ApiError && err.status === 404
          ? "The trading bot is not switched on for this deployment."
          : errorText(err),
      );
    }
  }, [scope]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 10_000);
    return () => clearInterval(t);
  }, [reload]);

  if (loadError && !state) {
    return (
      <div className="stack">
        <p className="notice small">{loadError}</p>
      </div>
    );
  }
  if (!state) {
    return (
      <section className="panel">
        <Skeleton lines={4} />
      </section>
    );
  }
  return (
    <div className="stack trading">
      {(state.serverWallet || scope === "server") && (
        <div className="row" role="tablist" style={{ gap: 8 }}>
          <button
            role="tab"
            aria-selected={scope === "own"}
            className={scope === "own" ? "primary" : "ghost"}
            onClick={() => setScope("own")}
          >
            My wallet
          </button>
          <button
            role="tab"
            aria-selected={scope === "server"}
            className={scope === "server" ? "primary" : "ghost"}
            onClick={() => setScope("server")}
          >
            Server wallet
          </button>
        </div>
      )}
      <p className="notice small">
        <LockIcon size={13} />{" "}
        {scope === "server"
          ? "The server wallet, run by every admin together. The bot trades real SOL from it."
          : "Admin preview. The bot trades real SOL from a wallet this server holds for you."}{" "}
        Fund it with what you can afford to lose.
      </p>
      <WalletPanel state={state} reload={reload} />
      {state.wallet && state.canTrade && <BotPanel state={state} reload={reload} />}
      {state.wallet && <PositionsPanel state={state} reload={reload} />}
      {state.canTrade && <TradeAlertsPanel />}
      {state.canTrade && <PaperPanel />}
      {state.canTrade && <BacktestPanel />}
    </div>
  );
}

function WalletPanel({ state, reload }: { state: TradingState; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [copied, setCopied] = useState(false);
  const now = useNow(30_000);
  const wallet = state.wallet;

  const create = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await confirmedTradingCall(`${base(state.scope)}/wallet`, "POST");
      await reload();
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (max: boolean) => {
    const lamports = max ? "max" : String(Math.round(Number(amount) * LAMPORTS));
    if (!max && !(Number(amount) > 0)) return setMsg("Enter an amount in SOL.");
    if (!state.withdrawTo) return setMsg("Withdrawals are not set up for this wallet.");
    if (!confirm(`Withdraw ${max ? "everything" : `${amount} SOL`} to ${shortAddress(state.withdrawTo)}?`))
      return;
    setBusy(true);
    setMsg(null);
    try {
      await confirmedTradingCall(`${base(state.scope)}/withdraw`, "POST", { amount: lamports });
      setAmount("");
      setMsg("Withdrawal requested. It is sent within a few seconds.");
      await reload();
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <LockIcon size={13} /> {state.scope === "server" ? "Server wallet" : "Trading wallet"}
          </span>
          <h2>{wallet ? sol(wallet.balanceLamports) : "No wallet yet"}</h2>
          <p className="muted small">
            {state.scope === "server" ? (
              <>
                Its key is in the trader service&apos;s environment (TRADING_SERVER_WALLET_SECRET_KEY) and
                never reaches this page.{" "}
                {state.withdrawTo
                  ? `Withdrawals go only to ${shortAddress(state.withdrawTo)} (TRADING_SERVER_WALLET_WITHDRAW_TO).`
                  : "Withdrawals are off: set TRADING_SERVER_WALLET_WITHDRAW_TO on the api and the trader."}
              </>
            ) : (
              <>
                Held on the server: its key is sealed under AWS KMS and never leaves it. Withdrawals go only
                to the wallet you signed in with
                {state.withdrawTo ? ` (${shortAddress(state.withdrawTo)})` : ""}.
              </>
            )}
          </p>
        </div>
      </header>
      {!state.keyProviderReady && (
        <p className="error small">Wallet custody is not configured: {state.keyProviderProblem}</p>
      )}
      {!wallet ? (
        state.canTrade &&
        state.scope === "own" && (
          <button className="primary" disabled={busy || !state.keyProviderReady} onClick={create}>
            Create trading wallet
          </button>
        )
      ) : (
        <>
          <dl className="facts">
            <div>
              <dt>Deposit address</dt>
              <dd className="num">
                <a
                  href={solscan("account", wallet.publicKey)}
                  target="_blank"
                  rel="noreferrer"
                  title={wallet.publicKey}
                >
                  {shortAddress(wallet.publicKey)} <ExternalIcon size={11} />
                </a>{" "}
                <button
                  className="ghost"
                  title="Copy the address"
                  onClick={() => {
                    void navigator.clipboard.writeText(wallet.publicKey).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  <CopyIcon size={12} /> {copied ? "Copied" : "Copy"}
                </button>
              </dd>
            </div>
            {wallet.createdAt && (
              <div>
                <dt>Created</dt>
                <dd>{ago(wallet.createdAt, now)}</dd>
              </div>
            )}
          </dl>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder="SOL"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ width: 120 }}
            />
            <button disabled={busy || !state.withdrawTo} onClick={() => void withdraw(false)}>
              Withdraw
            </button>
            <button disabled={busy || !state.withdrawTo} onClick={() => void withdraw(true)}>
              Withdraw all
            </button>
          </div>
          {state.withdrawals.length > 0 && (
            <ul className="muted small" style={{ marginTop: 10 }}>
              {state.withdrawals.slice(0, 5).map((w) => (
                <li key={w.id}>
                  {ago(w.createdAt, now)}:{" "}
                  {w.sentLamports
                    ? sol(w.sentLamports)
                    : w.requestedLamports
                      ? sol(w.requestedLamports)
                      : "all"}{" "}
                  -{" "}
                  <span
                    className={`badge ${w.status === "confirmed" ? "good" : w.status === "failed" ? "bad" : "info"}`}
                  >
                    {w.status}
                  </span>
                  {w.signature && (
                    <>
                      {" "}
                      <a href={solscan("tx", w.signature)} target="_blank" rel="noreferrer">
                        tx <ExternalIcon size={10} />
                      </a>
                    </>
                  )}
                  {w.error && <span className="error"> {w.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {msg && <p className="small">{msg}</p>}
    </section>
  );
}

const pct = (fraction: number) => Math.round(fraction * 1000) / 10;

/** The share of the position the ladder sells, 0-1. */
const soldOnLadder = (plan: ExitPlan) => plan.takeProfits.reduce((s, t) => s + t.sellFraction, 0);

/** A new rung above the highest, selling at most what the ladder leaves (the API rejects more than the whole). */
const nextTakeProfit = (plan: ExitPlan) => ({
  multiple: Math.max(1.5, ...plan.takeProfits.map((t) => t.multiple)) * 2,
  sellFraction: Math.min(0.25, Math.round((1 - soldOnLadder(plan)) * 100) / 100),
});

interface ConfigFormProps {
  /** The saved settings: the form follows them while nothing is being edited. */
  config: BotConfig;
  defaults: Ceilings & { exitPlan: ExitPlan; exitPlanSummary: string };
  sources: TradingState["sources"];
  /** A paper strategy's settings: no wallet-only fields, and the simulated fill penalty. */
  paper?: boolean;
  onSave: (config: BotConfig) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

/** The bot's settings, for the live bot and for each paper strategy. */
function ConfigForm({ config, defaults, sources, paper = false, onSave, onDirtyChange }: ConfigFormProps) {
  const [draft, setDraft] = useState<BotConfig>(config);
  const [dirty, setDirtyState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const setDirty = (next: boolean) => {
    setDirtyState(next);
    onDirtyChange?.(next);
  };

  // Follow the server while nothing is being edited.
  useEffect(() => {
    if (!dirty) setDraft(config);
  }, [config, dirty]);

  const edit = (next: BotConfig) => {
    setDraft(next);
    setDirty(true);
  };
  const plan = draft.exitPlan ?? defaults.exitPlan;
  const editPlan = (next: Partial<ExitPlan>) => edit({ ...draft, exitPlan: { ...plan, ...next } });
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const num = (v: string) => (v === "" ? 0 : Number(v));

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await onSave(draft);
      setDirty(false);
      setMsg("Saved.");
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="editor-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset>
        <legend>Buy on</legend>
        <p className="muted small">
          A filter produces signals while it is your active filter. Each token is bought at most once.
        </p>
        {sources.filters.map((f) => (
          <label className="check" key={f.id}>
            <input
              type="checkbox"
              checked={draft.sources.filterIds.includes(f.id)}
              onChange={() =>
                edit({
                  ...draft,
                  sources: { ...draft.sources, filterIds: toggle(draft.sources.filterIds, f.id) },
                })
              }
            />
            Filter: {f.name}{" "}
            {f.isActive ? (
              <span className="badge good">active</span>
            ) : (
              <span className="faint">(inactive)</span>
            )}
            {f.changedSinceSaved && draft.sources.filterIds.includes(f.id) && (
              <span className="badge bad" title="Edited since you saved these settings">
                changed: save to resume
              </span>
            )}
          </label>
        ))}
        {sources.models.map((m) => (
          <label className="check" key={m.id}>
            <input
              type="checkbox"
              checked={draft.sources.models.includes(m.id)}
              onChange={() =>
                edit({
                  ...draft,
                  sources: { ...draft.sources, models: toggle(draft.sources.models, m.id) },
                })
              }
            />
            Model: {m.name}
          </label>
        ))}
        <label className="check">
          <input
            type="checkbox"
            checked={draft.sources.highConvictionOnly}
            onChange={(e) =>
              edit({ ...draft, sources: { ...draft.sources, highConvictionOnly: e.target.checked } })
            }
          />
          Only high-conviction model calls
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.sources.requireAiBuy}
            onChange={(e) =>
              edit({ ...draft, sources: { ...draft.sources, requireAiBuy: e.target.checked } })
            }
          />
          Only buy what the AI judge calls a buy
        </label>
        {draft.sources.requireAiBuy && (
          <label className="field">
            <span>Least AI 2x estimate (%)</span>
            <input
              type="number"
              step="any"
              min={0}
              max={100}
              value={pct(draft.sources.minAiProbability2x)}
              onChange={(e) =>
                edit({
                  ...draft,
                  sources: { ...draft.sources, minAiProbability2x: num(e.target.value) / 100 },
                })
              }
            />
            <small className="faint">
              A signal waits for its review while it is fresh. The judge reviews high-conviction picks, so
              filter matches it never reviews are not bought.
            </small>
          </label>
        )}
      </fieldset>

      <fieldset>
        <legend>Size and guards</legend>
        <div className="grid2">
          <label className="field">
            <span>Buy size (SOL)</span>
            <input
              type="number"
              step="any"
              min={0}
              max={defaults.maxBuySol ?? undefined}
              value={draft.buySol}
              onChange={(e) => edit({ ...draft, buySol: num(e.target.value) })}
            />
            {defaults.maxBuySol !== null && (
              <small className="faint">Capped at {defaults.maxBuySol} SOL by the server.</small>
            )}
          </label>
          <label className="field">
            <span>Max open positions</span>
            <input
              type="number"
              step={1}
              min={1}
              value={draft.maxOpenPositions}
              onChange={(e) => edit({ ...draft, maxOpenPositions: num(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Max spend per 24h (SOL)</span>
            <input
              type="number"
              step="any"
              min={0}
              max={defaults.maxDailySpendSol ?? undefined}
              value={draft.maxDailySpendSol}
              onChange={(e) => edit({ ...draft, maxDailySpendSol: num(e.target.value) })}
            />
            {defaults.maxDailySpendSol !== null && (
              <small className="faint">Capped at {defaults.maxDailySpendSol} SOL by the server.</small>
            )}
          </label>
          <label className="field">
            <span>Skip signals older than (s)</span>
            <input
              type="number"
              step={1}
              min={5}
              max={86400}
              value={draft.maxSignalAgeSeconds}
              onChange={(e) => edit({ ...draft, maxSignalAgeSeconds: num(e.target.value) })}
            />
          </label>
          {paper ? (
            <label className="field">
              <span>Fill penalty (%)</span>
              <input
                type="number"
                step="any"
                min={0}
                max={100}
                value={(draft.fillPenaltyBps ?? 100) / 100}
                onChange={(e) => edit({ ...draft, fillPenaltyBps: Math.round(num(e.target.value) * 100) })}
              />
              <small className="faint">
                Taken off every simulated fill at the live quote, for what a real swap loses to latency and
                slippage.
              </small>
            </label>
          ) : (
            <>
              <label className="field">
                <span>Slippage (%)</span>
                <input
                  type="number"
                  step="any"
                  min={0.01}
                  max={(defaults.maxSlippageBps ?? 10_000) / 100}
                  value={draft.slippageBps / 100}
                  onChange={(e) => edit({ ...draft, slippageBps: Math.round(num(e.target.value) * 100) })}
                />
                {defaults.maxSlippageBps !== null && (
                  <small className="faint">At most {defaults.maxSlippageBps / 100}% on this server.</small>
                )}
              </label>
              <label className="field">
                <span>Exit slippage (%)</span>
                <input
                  type="number"
                  step="any"
                  min={0.01}
                  max={(defaults.maxExitSlippageBps ?? 10_000) / 100}
                  value={draft.exitSlippageBps / 100}
                  onChange={(e) => edit({ ...draft, exitSlippageBps: Math.round(num(e.target.value) * 100) })}
                />
                <small className="faint">
                  The least a stop, trail or timed exit sells with, so it gets out.
                  {defaults.maxExitSlippageBps != null &&
                    ` At most ${defaults.maxExitSlippageBps / 100}% on this server.`}
                </small>
              </label>
              <label className="field">
                <span>Exit slippage when retrying, up to (%)</span>
                <input
                  type="number"
                  step="any"
                  min={0.01}
                  max={(defaults.maxExitSlippageBps ?? 10_000) / 100}
                  value={draft.exitSlippageMaxBps / 100}
                  onChange={(e) =>
                    edit({ ...draft, exitSlippageMaxBps: Math.round(num(e.target.value) * 100) })
                  }
                />
                <small className="faint">Each failed protective exit widens by 5 points up to this.</small>
              </label>
              <label className="field">
                <span>Tries per entry</span>
                <input
                  type="number"
                  step={1}
                  min={1}
                  max={20}
                  value={draft.maxEntryTries}
                  onChange={(e) => edit({ ...draft, maxEntryTries: num(e.target.value) })}
                />
              </label>
            </>
          )}
          <label className="field">
            <span>Max priority fee (SOL)</span>
            <input
              type="number"
              step="any"
              min={0}
              max={defaults.maxPriorityFeeSol ?? undefined}
              value={draft.maxPriorityFeeSol}
              onChange={(e) => edit({ ...draft, maxPriorityFeeSol: num(e.target.value) })}
            />
            <small className="faint">
              {paper
                ? "Charged on each simulated swap when the Jito tip is 0."
                : "Also caps how far a retry raises the Jito tip."}
            </small>
          </label>
          <label className="field">
            <span>Jito tip (SOL)</span>
            <input
              type="number"
              step="any"
              min={0}
              value={draft.jitoTipSol}
              onChange={(e) => edit({ ...draft, jitoTipSol: num(e.target.value) })}
            />
            <small className="faint">
              Swaps go through Jito with this tip, out of reach of sandwich bots. 0 sends them normally.
            </small>
          </label>
          <label className="field">
            <span>Keep in reserve (SOL)</span>
            <input
              type="number"
              step="any"
              min={0}
              value={draft.reserveSol}
              onChange={(e) => edit({ ...draft, reserveSol: num(e.target.value) })}
            />
            <small className="faint">
              Fees and token-account rent come out of this. Too little, and a sale can&apos;t pay its fee.
            </small>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Loss limit and alerts</legend>
        <div className="grid2">
          <label className="field">
            <span>{paper ? "Stop" : "Pause"} after losing in 24h (SOL)</span>
            <input
              type="number"
              step="any"
              min={0}
              value={draft.dailyLossLimitSol}
              onChange={(e) => edit({ ...draft, dailyLossLimitSol: num(e.target.value) })}
            />
            <small className="faint">
              Counts trades closed in the last 24 hours since it was last started. 0 is off. Open positions
              keep their exit plans.
            </small>
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.notifyTelegram}
            onChange={(e) => edit({ ...draft, notifyTelegram: e.target.checked })}
          />
          Telegram alerts for each buy, sale and {paper ? "stop" : "pause"}
        </label>
        <p className="muted small">
          Sent to the private chats linked to your account in Settings, never to a group. Which kinds are sent
          is set once for all your bots, under Telegram trade alerts.
        </p>
      </fieldset>

      <fieldset>
        <legend>Exit plan</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.exitPlan === null}
            onChange={(e) => edit({ ...draft, exitPlan: e.target.checked ? null : defaults.exitPlan })}
          />
          Use the default plan
        </label>
        <p className="muted small">{draft.exitPlan === null ? defaults.exitPlanSummary : "Your own plan:"}</p>
        {draft.exitPlan !== null && (
          <>
            <h4 className="small">Take profits (share of the original position)</h4>
            {plan.takeProfits.map((tp, i) => (
              <div className="row" key={i} style={{ gap: 8, marginBottom: 6 }}>
                <label className="field">
                  <span>At (x)</span>
                  <input
                    type="number"
                    step="any"
                    min={1.01}
                    value={tp.multiple}
                    onChange={(e) =>
                      editPlan({
                        takeProfits: plan.takeProfits.map((t, j) =>
                          j === i ? { ...t, multiple: num(e.target.value) } : t,
                        ),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Sell (%)</span>
                  <input
                    type="number"
                    step="any"
                    min={1}
                    max={100}
                    value={pct(tp.sellFraction)}
                    onChange={(e) =>
                      editPlan({
                        takeProfits: plan.takeProfits.map((t, j) =>
                          j === i ? { ...t, sellFraction: num(e.target.value) / 100 } : t,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => editPlan({ takeProfits: plan.takeProfits.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            ))}
            {plan.takeProfits.length < 20 && soldOnLadder(plan) < 1 - 1e-9 && (
              <button
                type="button"
                className="ghost"
                onClick={() => editPlan({ takeProfits: [...plan.takeProfits, nextTakeProfit(plan)] })}
              >
                + Take profit
              </button>
            )}
            <div className="grid2" style={{ marginTop: 10 }}>
              <label className="field">
                <span>Stop loss (% drop)</span>
                <input
                  type="number"
                  step="any"
                  min={1}
                  max={100}
                  value={pct(1 - plan.stopFraction)}
                  onChange={(e) => editPlan({ stopFraction: 1 - num(e.target.value) / 100 })}
                />
                <small className="faint">Before the first sale (and after it, when there is no trail).</small>
              </label>
              <label className="field">
                <span>Close if never sold after (min)</span>
                <input
                  type="number"
                  step="any"
                  min={1}
                  value={plan.maxHoldMinutes}
                  onChange={(e) => editPlan({ maxHoldMinutes: num(e.target.value) })}
                />
              </label>
            </div>
            <h4 className="small">Trailing exit after the first sale</h4>
            {plan.trail.map((t, i) => (
              <div className="row" key={i} style={{ gap: 8, marginBottom: 6 }}>
                <label className="field">
                  <span>From (x)</span>
                  <input
                    type="number"
                    step="any"
                    min={0}
                    value={t.fromMultiple}
                    onChange={(e) =>
                      editPlan({
                        trail: plan.trail.map((x, j) =>
                          j === i ? { ...x, fromMultiple: num(e.target.value) } : x,
                        ),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Off the high (%)</span>
                  <input
                    type="number"
                    step="any"
                    min={1}
                    max={99}
                    value={pct(t.fraction)}
                    onChange={(e) =>
                      editPlan({
                        trail: plan.trail.map((x, j) =>
                          j === i ? { ...x, fraction: num(e.target.value) / 100 } : x,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => editPlan({ trail: plan.trail.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            ))}
            {plan.trail.length < 20 && (
              <button
                type="button"
                className="ghost"
                onClick={() => editPlan({ trail: [...plan.trail, { fromMultiple: 5, fraction: 0.25 }] })}
              >
                + Trail tier
              </button>
            )}
            <label className="field" style={{ marginTop: 10 }}>
              <span>Sell what the trail holds after (min)</span>
              <input
                type="number"
                step="any"
                min={1}
                value={plan.trailMaxHoldMinutes}
                onChange={(e) => editPlan({ trailMaxHoldMinutes: num(e.target.value) })}
              />
            </label>
          </>
        )}
      </fieldset>

      <div className="row" style={{ gap: 8 }}>
        <button className="primary" type="submit" disabled={busy || !dirty}>
          Save settings
        </button>
        {dirty && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setDraft(config);
              setDirty(false);
            }}
          >
            Discard
          </button>
        )}
        {msg && <span className="small">{msg}</span>}
      </div>
    </form>
  );
}

function BotPanel({ state, reload }: { state: TradingState; reload: () => Promise<void> }) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const now = useNow(15_000);

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      await confirmedTradingCall(`${base(state.scope)}/bot`, "PUT", { enabled });
      await reload();
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const saveConfig = async (config: BotConfig) => {
    await confirmedTradingCall(`${base(state.scope)}/bot`, "PUT", { config });
    await reload();
  };

  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <RobotIcon size={13} /> Bot
          </span>
          <h2>{state.bot.enabled ? "Trading" : "Paused"}</h2>
          <p className="muted small">
            {state.bot.lastRunAt ? `Last pass ${ago(state.bot.lastRunAt, now)}.` : "Not run yet."} Pausing
            stops new buys; open positions keep following their exit plan.
          </p>
          {state.bot.lastError && <p className="error small">{state.bot.lastError}</p>}
          {msg && <p className="error small">{msg}</p>}
        </div>
        <button
          className={state.bot.enabled ? "" : "primary"}
          disabled={busy || dirty}
          title={dirty ? "Save your changes first" : undefined}
          onClick={() => void setEnabled(!state.bot.enabled)}
        >
          <BoltIcon size={13} /> {state.bot.enabled ? "Pause" : "Start"}
        </button>
      </header>
      <ConfigForm
        config={state.bot.config}
        defaults={state.defaults}
        sources={state.sources}
        onSave={saveConfig}
        onDirtyChange={setDirty}
      />
    </section>
  );
}

const REASON: Record<string, string> = {
  take_profit: "take profit",
  stop_loss: "stop loss",
  trailing_stop: "trailing exit",
  max_hold: "time limit",
  trail_max_hold: "trail time limit",
  manual: "sold by you",
  empty: "empty",
};

function PositionsPanel({ state, reload }: { state: TradingState; reload: () => Promise<void> }) {
  const now = useNow(15_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const open = state.positions.filter(
    (p) => p.status === "open" || p.status === "buying" || p.status === "stuck",
  );
  const act = async (path: string, ask: string) => {
    if (!confirm(ask)) return;
    setBusy(true);
    setMsg(null);
    try {
      await confirmedTradingCall(path, "POST");
    } catch (err) {
      // A position sold or closed since the last refresh, say: the reload shows it as it is.
      setMsg(errorText(err));
    } finally {
      await reload();
      setBusy(false);
    }
  };
  const realized = (p: Position) => {
    if (p.status !== "closed" || !p.entryLamports || !p.proceedsLamports) return null;
    return Number(p.proceedsLamports) - Number(p.entryLamports);
  };

  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">Positions</span>
          <h2>
            {open.length} open · {state.positions.length - open.length} closed
          </h2>
        </div>
        {open.length > 0 && (
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              void act(`${base(state.scope)}/sell-all`, "Pause the bot and sell every open position?")
            }
          >
            Sell all and pause
          </button>
        )}
      </header>
      {msg && <p className="error small">{msg}</p>}
      {state.positions.length === 0 ? (
        <p className="muted small">No trades yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Signal</th>
                <th>Status</th>
                <th>Paid</th>
                <th>Now</th>
                <th>Result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.positions.map((p) => {
                const pnl = realized(p);
                return (
                  <tr key={p.id} title={p.exitPlanSummary}>
                    <td>
                      <a href={solscan("token", p.mint)} target="_blank" rel="noreferrer">
                        {p.symbol ?? shortAddress(p.mint)}
                      </a>
                    </td>
                    <td className="small">
                      {p.source}
                      <div className="faint">{ago(p.signalAt, now)}</div>
                    </td>
                    <td>
                      <span
                        className={`badge ${p.status === "open" ? "info" : p.status === "failed" || p.status === "stuck" ? "bad" : p.status === "closed" ? "" : "info"}`}
                      >
                        {p.status}
                      </span>
                      {p.closeReason && (
                        <div className="faint small">{REASON[p.closeReason] ?? p.closeReason}</div>
                      )}
                      {p.closeRequested && (p.status === "open" || p.status === "stuck") && (
                        <div className="faint small">selling…</div>
                      )}
                      {p.error && (
                        <div className="error small" title={p.error}>
                          {p.error.slice(0, 60)}
                        </div>
                      )}
                    </td>
                    <td className="num">{sol(p.entryLamports)}</td>
                    <td className="num">
                      {p.lastMultiple !== null && p.status === "open" ? `${p.lastMultiple.toFixed(2)}x` : "–"}
                      {p.rungsTaken > 0 && p.status === "open" && (
                        <div className="faint small">{p.rungsTaken} sold</div>
                      )}
                    </td>
                    <td className={`num ${pnl === null ? "" : pnl >= 0 ? "good" : "bad"}`}>
                      {pnl === null
                        ? p.proceedsLamports && p.proceedsLamports !== "0"
                          ? `+${sol(p.proceedsLamports)} back`
                          : "–"
                        : `${pnl >= 0 ? "+" : ""}${sol(String(pnl))}`}
                    </td>
                    <td>
                      {(p.status === "open" || p.status === "stuck") && !p.closeRequested && (
                        <button
                          className="ghost"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              `${base(state.scope)}/positions/${p.id}/sell`,
                              `Sell all of ${p.symbol ?? "this token"} now?`,
                            )
                          }
                        >
                          Sell
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface BacktestSlice {
  calls: number;
  wins: number;
  hitRate: number | null;
  avgReturnPct: number | null;
}
interface BacktestRow {
  model: string;
  name: string;
  all: BacktestSlice;
  high: BacktestSlice;
  aiBuy: BacktestSlice;
  highAiBuy: BacktestSlice;
}

const BACKTEST_SLICES = [
  ["all", "Every call"],
  ["high", "High conviction"],
  ["aiBuy", "AI buy"],
  ["highAiBuy", "High + AI buy"],
] as const;

/**
 * What each model's calls would have done lately, with and without the AI gate: how many were
 * graded, the share that doubled in the win window, and the average return under the default
 * exit plan. The evidence for picking sources (the project's goal is a 75% hit rate on 2x).
 */
function BacktestPanel() {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<BacktestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    api<{ models: BacktestRow[] }>(`/trading/backtest?days=${days}`)
      .then((r) => {
        setRows(r.models);
        setError(null);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [days]);
  const cell = (s: BacktestSlice) =>
    s.calls === 0 ? (
      <span className="faint">–</span>
    ) : (
      <>
        <span className={s.hitRate !== null && s.hitRate >= 0.75 ? "up" : undefined}>
          {Math.round((s.hitRate ?? 0) * 100)}%
        </span>{" "}
        <span className="faint">
          of {s.calls}
          {s.avgReturnPct !== null
            ? `, ${s.avgReturnPct >= 0 ? "+" : ""}${s.avgReturnPct.toFixed(0)}% avg`
            : ""}
        </span>
      </>
    );
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <BoltIcon size={13} /> What it would have bought
          </span>
          <h2>Hit rate on 2x</h2>
          <p className="muted small">
            Each model&apos;s graded calls: the share that doubled in the win window, and the average return
            under the default exit plan. The goal is 75% or better.
          </p>
        </div>
        <div className="row" role="group" aria-label="Window" style={{ gap: 6 }}>
          {[1, 7, 30].map((d) => (
            <button key={d} className={d === days ? "primary" : "ghost"} onClick={() => setDays(d)}>
              {d}d
            </button>
          ))}
        </div>
      </header>
      {error ? (
        <p className="error small">{error}</p>
      ) : !rows ? (
        <Skeleton lines={3} />
      ) : rows.length === 0 ? (
        <p className="muted small">No graded model calls in this window yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="small">
            <thead>
              <tr>
                <th>Model</th>
                {BACKTEST_SLICES.map(([, label]) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model}>
                  <td>{r.name}</td>
                  {BACKTEST_SLICES.map(([key]) => (
                    <td key={key} className="num">
                      {cell(r[key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Paper trading ──────────────────────────────────────────────────────────────────────────

interface PaperFill {
  side: "buy" | "sell";
  reason: string;
  lamports: string;
  feeLamports: string;
  multiple: number | null;
  createdAt: string;
}
interface PaperPosition {
  id: string;
  mint: string;
  symbol: string | null;
  source: string;
  signalAt: string;
  status: "open" | "closed";
  swapInLamports: string;
  feesLamports: string;
  proceedsLamports: string;
  rungsTaken: number;
  lastMultiple: number | null;
  peakMultiple: number | null;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  closeRequested: boolean;
  error: string | null;
  exitPlanSummary: string;
  fills: PaperFill[];
}
interface PaperStrategy {
  id: string;
  name: string;
  running: boolean;
  config: BotConfig;
  exitPlanSummary: string;
  bankrollLamports: string;
  cashLamports: string;
  lastRunAt: string | null;
  lastError: string | null;
  resetAt: string;
  recentSkips: { at: string; mint: string; symbol: string | null; source: string; why: string }[];
  changedFilters: string[];
  stats: {
    equityLamports: string;
    openValueLamports: string;
    pnlLamports: string;
    pnlPct: number;
    entries: number;
    open: number;
    closed: number;
    wins: number;
    winRate: number | null;
    /** Entries whose signal won its 2x verdict, of those graded (open signals count in neither). */
    hit2x: number;
    graded: number;
    hit2xRate: number | null;
  };
  positions: PaperPosition[];
}
interface PaperState {
  maxRunning: number;
  maxStrategies: number;
  defaults: { config: BotConfig; bankrollSol: number; exitPlan: ExitPlan; exitPlanSummary: string };
  sources: {
    filters: { id: string; name: string; isActive: boolean }[];
    models: { id: string; name: string }[];
  };
  strategies: PaperStrategy[];
}

const NO_CEILINGS: Ceilings = {
  maxBuySol: null,
  maxDailySpendSol: null,
  maxSlippageBps: null,
  maxExitSlippageBps: null,
  maxPriorityFeeSol: null,
};
const rate = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);
const signedSol = (lamports: string) => {
  const n = Number(lamports);
  return `${n >= 0 ? "+" : "−"}${(Math.abs(n) / LAMPORTS).toFixed(4)} SOL`;
};

/**
 * Paper trading: the bot's settings on live signals and live Jupiter quotes, with simulated SOL.
 * Nothing here holds a wallet or sends a transaction, so it works while the real bot is off. An
 * admin keeps several strategies and runs up to three at once.
 */
type TradeAlertEvent =
  "buy" | "take_profit" | "stop_loss" | "trailing_stop" | "time_limit" | "manual" | "loss_limit";
interface TradeAlerts {
  paper: boolean;
  bot: boolean;
  events: Record<TradeAlertEvent, boolean>;
}
const TRADE_ALERT_EVENTS: { id: TradeAlertEvent; label: string }[] = [
  { id: "buy", label: "Buys" },
  { id: "take_profit", label: "Take-profit sales" },
  { id: "stop_loss", label: "Stop-loss sales" },
  { id: "trailing_stop", label: "Trailing exits" },
  { id: "time_limit", label: "Time-limit sales" },
  { id: "manual", label: "Sales you asked for" },
  { id: "loss_limit", label: "Loss-limit stops and pauses" },
];

/**
 * Which trade notes reach the admin's private Telegram chats: paper strategies and the live bot
 * on or off, and which kinds, the same for both. Each switch saves as it is pressed. Layered on
 * each bot's and strategy's own "Telegram alerts" box: a note goes out only when both allow it.
 */
function TradeAlertsPanel() {
  const [alerts, setAlerts] = useState<TradeAlerts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ alerts: TradeAlerts }>("/trading/alerts")
      .then((res) => setAlerts(res.alerts))
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  const save = async (
    patch: Partial<Omit<TradeAlerts, "events">> & { events?: Partial<TradeAlerts["events"]> },
  ) => {
    if (!alerts) return;
    const before = alerts;
    setAlerts({ ...alerts, ...patch, events: { ...alerts.events, ...(patch.events ?? {}) } });
    try {
      const res = await confirmedTradingCall<{ alerts: TradeAlerts }>("/trading/alerts", "PUT", patch);
      setAlerts(res.alerts);
      setError(null);
    } catch (err) {
      setAlerts(before);
      setError(errorText(err));
    }
  };

  const anySource = alerts ? alerts.paper || alerts.bot : false;
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <BoltIcon size={13} /> Telegram trade alerts
          </span>
          <h2>{!alerts ? "Alerts" : anySource ? "On" : "Off"}</h2>
          <p className="muted small">
            What your trading bot and paper strategies tell your private Telegram chats. The same choices
            apply to both. Each bot and strategy also has its own on/off box in its settings.
          </p>
        </div>
      </header>
      {error && <p className="error small">{error}</p>}
      {!alerts ? (
        <Skeleton lines={3} />
      ) : (
        <>
          <fieldset>
            <legend>From</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={alerts.paper}
                onChange={(e) => void save({ paper: e.target.checked })}
              />
              Paper strategies
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={alerts.bot}
                onChange={(e) => void save({ bot: e.target.checked })}
              />
              Trading bot
            </label>
          </fieldset>
          <fieldset disabled={!anySource}>
            <legend>Which alerts</legend>
            <div className="grid2">
              {TRADE_ALERT_EVENTS.map((ev) => (
                <label className="check" key={ev.id}>
                  <input
                    type="checkbox"
                    checked={alerts.events[ev.id]}
                    onChange={(e) => void save({ events: { [ev.id]: e.target.checked } })}
                  />
                  {ev.label}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      )}
    </section>
  );
}

function PaperPanel() {
  const [state, setState] = useState<PaperState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setState(await api<PaperState>("/trading/paper"));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 10_000);
    return () => clearInterval(t);
  }, [reload]);

  const create = async () => {
    setBusy(true);
    try {
      await api("/trading/paper", { method: "POST", body: JSON.stringify({}) });
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const running = state?.strategies.filter((s) => s.running).length ?? 0;
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <RobotIcon size={13} /> Paper trading
          </span>
          <h2>{state ? `${running} of ${state.maxRunning} running` : "Strategies"}</h2>
          <p className="muted small">
            Simulated SOL, live signals. Each strategy buys what the bot would, at the live Jupiter quote less
            its fill penalty, pays the network fee and tip, and sells on its exit plan. No wallet, no
            transactions. Run up to {state?.maxRunning ?? 3} at once.
          </p>
        </div>
        <button
          className="primary"
          disabled={busy || !state || state.strategies.length >= state.maxStrategies}
          title={
            state && state.strategies.length >= state.maxStrategies
              ? `At most ${state.maxStrategies} strategies; delete one first`
              : undefined
          }
          onClick={() => void create()}
        >
          + New strategy
        </button>
      </header>
      {error && <p className="error small">{error}</p>}
      {!state ? (
        <Skeleton lines={3} />
      ) : state.strategies.length === 0 ? (
        <p className="muted small">No strategies yet. Make one, pick what it follows, and start it.</p>
      ) : (
        <div className="stack">
          {state.strategies.map((s) => (
            <PaperStrategyCard
              key={s.id}
              strategy={s}
              state={state}
              canStart={running < state.maxRunning}
              reload={reload}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PaperStrategyCard({
  strategy: s,
  state,
  canStart,
  reload,
}: {
  strategy: PaperStrategy;
  state: PaperState;
  canStart: boolean;
  reload: () => Promise<void>;
}) {
  const now = useNow(15_000);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const url = `/trading/paper/${s.id}`;

  const call = async (path: string, method: string, body?: unknown) => {
    setBusy(true);
    setMsg(null);
    try {
      await api(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      await reload();
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const rename = () => {
    const name = prompt("Name this strategy", s.name)?.trim();
    if (name && name !== s.name) void call(url, "PATCH", { name });
  };
  const reset = () => {
    const answer = prompt(
      "Reset to a fresh bankroll (SOL)? Its trades and results are cleared.",
      String(Number(s.bankrollLamports) / LAMPORTS),
    );
    if (answer === null) return;
    const bankrollSol = Number(answer);
    if (!(bankrollSol > 0)) return setMsg("Enter a bankroll above 0 SOL.");
    void call(`${url}/reset`, "POST", { bankrollSol });
  };
  const sources = {
    filters: state.sources.filters.map((f) => ({ ...f, changedSinceSaved: s.changedFilters.includes(f.id) })),
    models: state.sources.models,
  };
  const pnl = Number(s.stats.pnlLamports);
  const following = [
    ...state.sources.models.filter((m) => s.config.sources.models.includes(m.id)).map((m) => m.name),
    ...state.sources.filters.filter((f) => s.config.sources.filterIds.includes(f.id)).map((f) => f.name),
  ];

  return (
    <article className="panel" style={{ margin: 0 }}>
      <header className="section-head">
        <div>
          <h3 style={{ margin: 0 }}>
            {s.name}{" "}
            <span className={`badge ${s.running ? "good" : ""}`}>{s.running ? "running" : "stopped"}</span>
          </h3>
          <p className="muted small">
            {following.length > 0
              ? `Follows ${following.join(", ")}`
              : "Follows nothing yet: pick sources in Settings"}
            {s.config.sources.requireAiBuy ? ", AI buys only" : ""}. {s.config.buySol} SOL a buy.{" "}
            {s.lastRunAt ? `Last pass ${ago(s.lastRunAt, now)}.` : ""}
          </p>
          {s.lastError && <p className="error small">{s.lastError}</p>}
          {msg && <p className="error small">{msg}</p>}
        </div>
        <button
          className={s.running ? "" : "primary"}
          disabled={busy || dirty || (!s.running && !canStart)}
          title={
            dirty
              ? "Save your changes first"
              : !s.running && !canStart
                ? `${state.maxRunning} are running; stop one first`
                : undefined
          }
          onClick={() => void call(url, "PATCH", { running: !s.running })}
        >
          <BoltIcon size={13} /> {s.running ? "Stop" : "Start"}
        </button>
      </header>
      <dl className="facts">
        <div>
          <dt>Equity</dt>
          <dd className="num">{sol(s.stats.equityLamports)}</dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd className={`num ${pnl > 0 ? "good" : pnl < 0 ? "bad" : ""}`}>
            {signedSol(s.stats.pnlLamports)} ({s.stats.pnlPct >= 0 ? "+" : ""}
            {s.stats.pnlPct.toFixed(1)}%)
          </dd>
        </div>
        <div>
          <dt>Cash</dt>
          <dd className="num">
            {sol(s.cashLamports)} <span className="faint">of {sol(s.bankrollLamports, 2)}</span>
          </dd>
        </div>
        <div>
          <dt>Trades</dt>
          <dd className="num">
            {s.stats.open} open · {s.stats.closed} closed
          </dd>
        </div>
        <div>
          <dt>Won</dt>
          <dd className="num">
            {rate(s.stats.winRate)} <span className="faint">of closed</span>
          </dd>
        </div>
        <div>
          <dt>Hit 2x</dt>
          <dd className={`num ${s.stats.hit2xRate !== null && s.stats.hit2xRate >= 0.75 ? "up" : ""}`}>
            {rate(s.stats.hit2xRate)}{" "}
            <span className="faint">
              {s.stats.hit2x} of {s.stats.graded} graded
            </span>
          </dd>
        </div>
      </dl>

      <details style={{ marginTop: 8 }}>
        <summary>Settings</summary>
        <ConfigForm
          paper
          config={s.config}
          defaults={{
            ...NO_CEILINGS,
            exitPlan: state.defaults.exitPlan,
            exitPlanSummary: state.defaults.exitPlanSummary,
          }}
          sources={sources}
          onSave={async (config) => {
            await api(url, { method: "PATCH", body: JSON.stringify({ config }) });
            await reload();
          }}
          onDirtyChange={setDirty}
        />
      </details>

      <details>
        <summary>Trades ({s.stats.entries})</summary>
        {s.positions.length === 0 ? (
          <p className="muted small">No trades yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Signal</th>
                  <th>Status</th>
                  <th>Cost</th>
                  <th>Now · peak</th>
                  <th>Result</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.positions.map((p) => {
                  const cost = Number(p.swapInLamports) + Number(p.feesLamports);
                  const result = Number(p.proceedsLamports) - cost;
                  return (
                    <tr key={p.id} title={p.exitPlanSummary}>
                      <td>
                        <a href={solscan("token", p.mint)} target="_blank" rel="noreferrer">
                          {p.symbol ?? shortAddress(p.mint)}
                        </a>
                      </td>
                      <td className="small">
                        {p.source}
                        <div className="faint">{ago(p.signalAt, now)}</div>
                      </td>
                      <td>
                        <span className={`badge ${p.status === "open" ? "info" : ""}`}>{p.status}</span>
                        {p.closeReason && (
                          <div className="faint small">{REASON[p.closeReason] ?? p.closeReason}</div>
                        )}
                        {p.closeRequested && p.status === "open" && (
                          <div className="faint small">selling…</div>
                        )}
                        {p.error && p.status === "open" && (
                          <div className="error small" title={p.error}>
                            {p.error.slice(0, 60)}
                          </div>
                        )}
                      </td>
                      <td className="num">{sol(String(cost))}</td>
                      <td className="num">
                        {p.status === "open" && p.lastMultiple !== null
                          ? `${p.lastMultiple.toFixed(2)}x`
                          : "–"}
                        {p.peakMultiple !== null && (
                          <div className="faint small">peak {p.peakMultiple.toFixed(2)}x</div>
                        )}
                      </td>
                      <td className={`num ${p.status === "closed" ? (result >= 0 ? "good" : "bad") : ""}`}>
                        {p.status === "closed"
                          ? signedSol(String(result))
                          : p.proceedsLamports !== "0"
                            ? `+${sol(p.proceedsLamports)} back`
                            : "–"}
                      </td>
                      <td>
                        {p.status === "open" && !p.closeRequested && (
                          <button
                            className="ghost"
                            disabled={busy}
                            onClick={() => void call(`${url}/positions/${p.id}/close`, "POST")}
                          >
                            Sell
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </details>

      <details>
        <summary>Passed on ({s.recentSkips.length})</summary>
        {s.recentSkips.length === 0 ? (
          <p className="muted small">Nothing passed on yet.</p>
        ) : (
          <ul className="small">
            {s.recentSkips.map((k, i) => (
              <li key={`${k.mint}-${i}`}>
                <strong>{k.symbol ?? shortAddress(k.mint)}</strong> <span className="faint">{k.source}</span>:{" "}
                {k.why} <span className="faint">{ago(k.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </details>

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        <button className="ghost" disabled={busy} onClick={rename}>
          Rename
        </button>
        <button
          className="ghost"
          disabled={busy || state.strategies.length >= state.maxStrategies}
          onClick={() =>
            void call("/trading/paper", "POST", { copyFrom: s.id, name: `${s.name} copy`.slice(0, 60) })
          }
        >
          Copy
        </button>
        <button className="ghost" disabled={busy} onClick={reset}>
          Reset
        </button>
        {s.stats.open > 0 && (
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              confirm("Stop it and sell every open position?") && void call(`${url}/close-all`, "POST")
            }
          >
            Sell all and stop
          </button>
        )}
        <button
          className="danger"
          disabled={busy}
          onClick={() => confirm(`Delete ${s.name} and its trades?`) && void call(url, "DELETE")}
        >
          Delete
        </button>
      </div>
    </article>
  );
}
