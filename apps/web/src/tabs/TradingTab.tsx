import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { BoltIcon, CopyIcon, ExternalIcon, LockIcon, RobotIcon } from "../components/Icons";
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
  sources: { filterIds: string[]; models: string[]; highConvictionOnly: boolean };
  buySol: number;
  maxOpenPositions: number;
  maxDailySpendSol: number;
  maxSignalAgeSeconds: number;
  slippageBps: number;
  maxPriorityFeeSol: number;
  reserveSol: number;
  exitPlan: ExitPlan | null;
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
interface TradingState {
  canTrade: boolean;
  keyProviderReady: boolean;
  keyProviderProblem: string | null;
  withdrawTo: string;
  wallet: { publicKey: string; createdAt: string; balanceLamports: string | null } | null;
  bot: {
    enabled: boolean;
    config: BotConfig;
    lastRunAt: string | null;
    lastError: string | null;
    exitPlanSummary: string;
  };
  defaults: {
    exitPlan: ExitPlan;
    exitPlanSummary: string;
    maxBuySol: number;
    maxDailySpendSol: number;
    maxSlippageBps: number;
  };
  sources: {
    filters: { id: string; name: string; isActive: boolean; changedSinceSaved: boolean }[];
    models: { id: string; name: string }[];
  };
  positions: Position[];
  withdrawals: Withdrawal[];
}

const LAMPORTS = 1_000_000_000;
const sol = (lamports: string | null | undefined, digits = 4) =>
  lamports === null || lamports === undefined ? "–" : `${(Number(lamports) / LAMPORTS).toFixed(digits)} SOL`;
const solscan = (kind: "account" | "tx" | "token", id: string) => `https://solscan.io/${kind}/${id}`;
const errorText = (err: unknown) =>
  err instanceof ApiError && typeof (err.body as { error?: unknown })?.error === "string"
    ? (err.body as { error: string }).error
    : String(err instanceof Error ? err.message : err);

export function TradingTab() {
  const [state, setState] = useState<TradingState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setState(await api<TradingState>("/trading"));
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof ApiError && err.status === 404
          ? "The trading bot is not switched on for this deployment."
          : errorText(err),
      );
    }
  }, []);

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
      <p className="notice small">
        <LockIcon size={13} /> Admin preview. The bot trades real SOL from a wallet this server holds for you.
        Fund it with what you can afford to lose.
      </p>
      <WalletPanel state={state} reload={reload} />
      {state.wallet && state.canTrade && <BotPanel state={state} reload={reload} />}
      {state.wallet && <PositionsPanel state={state} reload={reload} />}
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
      await api("/trading/wallet", { method: "POST" });
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
    if (!confirm(`Withdraw ${max ? "everything" : `${amount} SOL`} to ${shortAddress(state.withdrawTo)}?`))
      return;
    setBusy(true);
    setMsg(null);
    try {
      await api("/trading/withdraw", { method: "POST", body: JSON.stringify({ amount: lamports }) });
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
            <LockIcon size={13} /> Trading wallet
          </span>
          <h2>{wallet ? sol(wallet.balanceLamports) : "No wallet yet"}</h2>
          <p className="muted small">
            Held on the server: its key is sealed under AWS KMS and never leaves it. Withdrawals go only to
            the wallet you signed in with ({shortAddress(state.withdrawTo)}).
          </p>
        </div>
      </header>
      {!state.keyProviderReady && (
        <p className="error small">Wallet custody is not configured: {state.keyProviderProblem}</p>
      )}
      {!wallet ? (
        state.canTrade && (
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
            <div>
              <dt>Created</dt>
              <dd>{ago(wallet.createdAt, now)}</dd>
            </div>
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
            <button disabled={busy} onClick={() => void withdraw(false)}>
              Withdraw
            </button>
            <button disabled={busy} onClick={() => void withdraw(true)}>
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

function BotPanel({ state, reload }: { state: TradingState; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState<BotConfig>(state.bot.config);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const now = useNow(15_000);

  // Follow the server while nothing is being edited.
  useEffect(() => {
    if (!dirty) setDraft(state.bot.config);
  }, [state.bot.config, dirty]);

  const edit = (next: BotConfig) => {
    setDraft(next);
    setDirty(true);
  };
  const plan = draft.exitPlan ?? state.defaults.exitPlan;
  const editPlan = (next: Partial<ExitPlan>) => edit({ ...draft, exitPlan: { ...plan, ...next } });
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const save = async (patch: { enabled?: boolean; config?: BotConfig }) => {
    setBusy(true);
    setMsg(null);
    try {
      await api("/trading/bot", { method: "PUT", body: JSON.stringify(patch) });
      if (patch.config) setDirty(false);
      await reload();
      setMsg(patch.config ? "Saved." : null);
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const num = (v: string) => (v === "" ? 0 : Number(v));

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
        </div>
        <button
          className={state.bot.enabled ? "" : "primary"}
          disabled={busy || dirty}
          title={dirty ? "Save your changes first" : undefined}
          onClick={() => void save({ enabled: !state.bot.enabled })}
        >
          <BoltIcon size={13} /> {state.bot.enabled ? "Pause" : "Start"}
        </button>
      </header>

      <form
        className="editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ config: draft });
        }}
      >
        <fieldset>
          <legend>Buy on</legend>
          <p className="muted small">
            A filter produces signals while it is your active filter. Each token is bought at most once.
          </p>
          {state.sources.filters.map((f) => (
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
          {state.sources.models.map((m) => (
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
                max={state.defaults.maxBuySol}
                value={draft.buySol}
                onChange={(e) => edit({ ...draft, buySol: num(e.target.value) })}
              />
              <small className="faint">Capped at {state.defaults.maxBuySol} SOL by the server.</small>
            </label>
            <label className="field">
              <span>Max open positions</span>
              <input
                type="number"
                step={1}
                min={1}
                max={50}
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
                max={state.defaults.maxDailySpendSol}
                value={draft.maxDailySpendSol}
                onChange={(e) => edit({ ...draft, maxDailySpendSol: num(e.target.value) })}
              />
              <small className="faint">Capped at {state.defaults.maxDailySpendSol} SOL by the server.</small>
            </label>
            <label className="field">
              <span>Skip signals older than (s)</span>
              <input
                type="number"
                step={1}
                min={5}
                max={3600}
                value={draft.maxSignalAgeSeconds}
                onChange={(e) => edit({ ...draft, maxSignalAgeSeconds: num(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>Slippage (%)</span>
              <input
                type="number"
                step="any"
                min={0.1}
                max={state.defaults.maxSlippageBps / 100}
                value={draft.slippageBps / 100}
                onChange={(e) => edit({ ...draft, slippageBps: Math.round(num(e.target.value) * 100) })}
              />
              <small className="faint">
                At most {state.defaults.maxSlippageBps / 100}% on this server. Stops and trailing exits allow
                at least 30% so they get out.
              </small>
            </label>
            <label className="field">
              <span>Max priority fee (SOL)</span>
              <input
                type="number"
                step="any"
                min={0}
                max={0.1}
                value={draft.maxPriorityFeeSol}
                onChange={(e) => edit({ ...draft, maxPriorityFeeSol: num(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>Keep in reserve (SOL)</span>
              <input
                type="number"
                step="any"
                min={0.005}
                value={draft.reserveSol}
                onChange={(e) => edit({ ...draft, reserveSol: num(e.target.value) })}
              />
              <small className="faint">Fees and token-account rent come out of this.</small>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Exit plan</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.exitPlan === null}
              onChange={(e) =>
                edit({ ...draft, exitPlan: e.target.checked ? null : state.defaults.exitPlan })
              }
            />
            Use the default plan
          </label>
          <p className="muted small">
            {draft.exitPlan === null ? state.defaults.exitPlanSummary : "Your own plan:"}
          </p>
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
              {plan.takeProfits.length < 6 && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    editPlan({ takeProfits: [...plan.takeProfits, { multiple: 3, sellFraction: 0.25 }] })
                  }
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
                  <small className="faint">
                    Before the first sale (and after it, when there is no trail).
                  </small>
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
              {plan.trail.length < 6 && (
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
                setDraft(state.bot.config);
                setDirty(false);
              }}
            >
              Discard
            </button>
          )}
          {msg && <span className="small">{msg}</span>}
        </div>
      </form>
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
  const open = state.positions.filter(
    (p) => p.status === "open" || p.status === "buying" || p.status === "stuck",
  );
  const act = async (path: string, ask: string) => {
    if (!confirm(ask)) return;
    setBusy(true);
    try {
      await api(path, { method: "POST" });
      await reload();
    } finally {
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
            onClick={() => void act("/trading/sell-all", "Pause the bot and sell every open position?")}
          >
            Sell all and pause
          </button>
        )}
      </header>
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
                              `/trading/positions/${p.id}/sell`,
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
