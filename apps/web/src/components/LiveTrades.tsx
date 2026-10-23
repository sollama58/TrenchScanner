import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usd } from "../format";
import {
  coinLabels,
  filterCount,
  filterTrades,
  NO_FILTER,
  SIDE_LABELS,
  sinceText,
  solText,
  tallyTrades,
  traderLabels,
  TRADE_LABELS,
  useLiveTrades,
  useTradeFilter,
  type LabelFlagged,
  type LabelSnapshot,
  type LiveTokenTrade,
  type TradeFilter,
  type TradeLabel,
} from "../liveTrades";
import { usePossibleSides } from "../possibleSides";
import { openWallet } from "../walletModal";
import { useWalletNames } from "../walletNames";
import { WalletText } from "./WalletText";
import { PulseIcon } from "./Icons";

type SideFilter = "all" | "buy" | "sell";

/** The summary line's window. */
const TALLY_MS = 5 * 60_000;
/** Wallet names are asked for this often at most, so a busy coin's new traders come in batches. */
const NAMES_EVERY_MS = 5_000;
/** useWalletNames' options for the traders: no Helius read. */
const OWN_NAMES = { identity: false };
/** Rows drawn at most: the newest. */
const SHOWN = 120;

/**
 * The wallets to name, refreshed every NAMES_EVERY_MS rather than on each trade: every trader the
 * feed holds, so the wallet filter can tell what each one is, not only the rows drawn.
 */
export function useBatchedWallets(trades: readonly LiveTokenTrade[]): string[] {
  const [wallets, setWallets] = useState<string[]>([]);
  const latest = useRef(trades);
  useEffect(() => {
    latest.current = trades;
  });
  const empty = trades.length === 0;
  useEffect(() => {
    if (empty) return;
    const read = () => {
      // Newest traders first: names are read 200 at a time, and in address order a busy coin's new
      // KOL waited behind its older traders, its mark late or never (user report 2026-10-20).
      const next: string[] = [];
      const seen = new Set<string>();
      for (let i = latest.current.length - 1; i >= 0; i--) {
        const w = latest.current[i]!.wallet;
        if (!seen.has(w)) {
          seen.add(w);
          next.push(w);
        }
      }
      setWallets((prev) => (prev.join() === next.join() ? prev : next));
    };
    read();
    const t = window.setInterval(read, NAMES_EVERY_MS);
    return () => window.clearInterval(t);
  }, [empty]);
  return wallets;
}

/** Ticks once a second while mounted, for the rows' ages. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** A typed SOL size: a number at or above zero, else none. */
function solInput(v: string): number | null {
  const n = v.trim() === "" ? Number.NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The filter's panel: the trade's size, and the kinds of wallet to show. */
function FilterPanel({
  filter,
  onChange,
  id,
}: {
  filter: TradeFilter;
  onChange: (f: TradeFilter) => void;
  id: string;
}) {
  // What's typed stays as typed ("0." on the way to "0.5"); the filter takes it once it reads as a size.
  const [min, setMin] = useState(filter.minSol?.toString() ?? "");
  const [max, setMax] = useState(filter.maxSol?.toString() ?? "");
  const toggle = (l: TradeLabel) =>
    onChange({
      ...filter,
      labels: filter.labels.includes(l) ? filter.labels.filter((x) => x !== l) : [...filter.labels, l],
    });
  const group = (scope: "all" | "coin", title: string, note: string) => (
    <div className="lt-fgroup">
      <span className="lt-flabel" title={note}>
        {title}
      </span>
      <div className="lt-chips">
        {TRADE_LABELS.filter((l) => l.scope === scope).map((l) => (
          <button
            key={l.id}
            type="button"
            className={`lt-chip${filter.labels.includes(l.id) ? " on" : ""}`}
            aria-pressed={filter.labels.includes(l.id)}
            title={l.title}
            onClick={() => toggle(l.id)}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <div className="lt-fpanel" id={id}>
      <div className="lt-fgroup">
        <span className="lt-flabel">Amount</span>
        <div className="lt-amount">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder="Min"
            aria-label="Smallest trade, SOL"
            value={min}
            onChange={(e) => {
              setMin(e.target.value);
              onChange({ ...filter, minSol: solInput(e.target.value) });
            }}
          />
          <span className="muted">to</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder="Max"
            aria-label="Largest trade, SOL"
            value={max}
            onChange={(e) => {
              setMax(e.target.value);
              onChange({ ...filter, maxSol: solInput(e.target.value) });
            }}
          />
          <span className="muted">SOL</span>
        </div>
      </div>
      {group("all", "Wallets", "Labels a wallet carries on every coin")}
      {group(
        "coin",
        "In this coin",
        "What this coin's scan and chart read of its wallets: its top holders and flagged traders",
      )}
      <div className="lt-factions">
        <span className="muted small">A trade shows when its wallet has any picked label.</span>
        <button
          type="button"
          className="lt-link"
          disabled={filterCount(filter) === 0}
          onClick={() => {
            setMin("");
            setMax("");
            onChange(NO_FILTER);
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

/**
 * The coin's trades as they land (user ask 2026-10-19): each buy and sell with its wallet, SOL and
 * the market cap it left, newest first, and the last five minutes' buys and sells above them. The
 * API follows the coin's trades on the chain stream only while this is open (liveTrades.ts).
 *
 * The reader can filter it by the trade's size and by wallet (user ask 2026-10-19): KOLs, their
 * sides, their own labels and the like on any trader, and what the coin's scan and chart read of
 * its holders and flagged wallets. The tally above follows the filter.
 */
export function LiveTradesCard({
  base,
  snapshot,
  flagged = [],
}: {
  base: string;
  /** The coin's holder reading, for the labels read in this coin (snipers, clusters and the like). */
  snapshot?: LabelSnapshot | null;
  /** The chart's flagged wallets in the coin (KOLs, sides, dev, risky, winners). */
  flagged?: readonly LabelFlagged[];
}) {
  const feed = useLiveTrades(base, true);
  const [side, setSide] = useState<SideFilter>("all");
  const [filter, setFilter] = useTradeFilter();
  const [panel, setPanel] = useState(false);
  const panelId = useId();
  const now = useNow();
  const traders = useBatchedWallets(feed.trades);
  // TrenchScanner's own names only: Helius's rarely matter for traders (user ask 2026-10-20).
  const names = useWalletNames(traders, OWN_NAMES);
  // KOL ties are read for every trader only while a side label is picked: otherwise names and the
  // coin's own read are all the filter needs.
  const needSides = filter.labels.some((l) => SIDE_LABELS.has(l));
  const sides = usePossibleSides(needSides ? traders : NO_WALLETS);
  const coin = useMemo(() => coinLabels(snapshot, flagged), [snapshot, flagged]);
  const filtered = useMemo(() => {
    const cache = new Map<string, ReadonlySet<TradeLabel>>();
    const labelsOf = (w: string) => {
      let l = cache.get(w);
      if (!l) cache.set(w, (l = traderLabels(w, coin, names[w], sides[w])));
      return l;
    };
    return filterTrades(feed.trades, filter, labelsOf);
  }, [feed.trades, filter, coin, names, sides]);
  const tally = useMemo(() => tallyTrades(filtered, now - TALLY_MS), [filtered, now]);
  const rows = useMemo(() => {
    const shown = side === "all" ? filtered : filtered.filter((t) => t.side === side);
    return shown.slice(-SHOWN).reverse();
  }, [filtered, side]);
  const net = tally.solIn - tally.solOut;
  const count = filterCount(filter);

  return (
    <section className="sage-card lt-card" aria-label="Live trades">
      <h4>
        <PulseIcon size={14} /> Live trades
        <span
          className={`lt-state ${feed.status ?? "pending"}`}
          title={
            feed.status === "live" && feed.since
              ? `Every trade since ${new Date(feed.since).toLocaleTimeString()}, as it lands on chain`
              : undefined
          }
        >
          {feed.status === "live"
            ? "Live"
            : feed.status === "unavailable"
              ? feed.busy
                ? "Waiting"
                : "Off"
              : "Connecting"}
        </span>
        <span className="segmented small lt-filter" role="radiogroup" aria-label="Show">
          {(["all", "buy", "sell"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={side === s}
              className={side === s ? "on" : ""}
              onClick={() => setSide(s)}
            >
              {s === "all" ? "All" : s === "buy" ? "Buys" : "Sells"}
            </button>
          ))}
        </span>
        <button
          type="button"
          className={`lt-fbtn${count > 0 ? " on" : ""}${panel ? " open" : ""}`}
          aria-expanded={panel}
          aria-controls={panelId}
          title="Filter by amount and wallet"
          onClick={() => setPanel((p) => !p)}
        >
          Filter{count > 0 && <span className="lt-fcount num">{count}</span>}
        </button>
      </h4>
      {panel && <FilterPanel filter={filter} onChange={setFilter} id={panelId} />}
      {feed.status === "unavailable" && feed.busy ? (
        <p className="muted small lt-empty">
          Live trades are following as many coins as they can just now (four open at once per account). This
          one starts by itself once another coin's page has been closed for a little while.
        </p>
      ) : feed.status === "unavailable" ? (
        <p className="muted small lt-empty">
          Live trades follow Pump.fun coins, on their bonding curve and after it on PumpSwap. This coin trades
          elsewhere, so there's nothing to follow here.
        </p>
      ) : (
        <>
          <dl
            className="lt-tally"
            title={
              count > 0
                ? "The last five minutes of the trades that pass your filter"
                : "The last five minutes of the trades read since this opened"
            }
          >
            <div>
              <dt>Buys 5m</dt>
              <dd className="num up">
                {tally.buys} <span className="lt-sub">{solText(tally.solIn)} SOL</span>
              </dd>
            </div>
            <div>
              <dt>Sells 5m</dt>
              <dd className="num down">
                {tally.sells} <span className="lt-sub">{solText(tally.solOut)} SOL</span>
              </dd>
            </div>
            <div>
              <dt>Net 5m</dt>
              <dd className={`num ${net >= 0 ? "up" : "down"}`}>
                {net >= 0 ? "+" : "-"}
                {solText(Math.abs(net))} <span className="lt-sub">SOL in less out</span>
              </dd>
            </div>
            <div>
              <dt>Traders</dt>
              <dd className="num">
                {tally.traders} <span className="lt-sub">wallets</span>
              </dd>
            </div>
          </dl>
          {count > 0 && feed.trades.length > 0 && (
            <p className="lt-fnote muted small">
              Showing {filtered.length} of {feed.trades.length} trades.{" "}
              <button
                type="button"
                className="lt-link"
                onClick={() => {
                  // Closed too, so the panel's boxes open on the cleared filter, not the old text.
                  setFilter(NO_FILTER);
                  setPanel(false);
                }}
              >
                Show all
              </button>
            </p>
          )}
          {rows.length === 0 ? (
            <p className="muted small lt-empty">
              {count > 0 && feed.trades.length > 0
                ? "No trades match your filter yet. Matching trades show here as they land."
                : feed.status === "live"
                  ? "Watching the chain: each trade shows here the moment it lands."
                  : "Connecting to the coin's trades…"}
            </p>
          ) : (
            <ol className="lt-list" aria-live="off">
              {rows.map((t) => (
                <li key={`${t.seq}`} className={`lt-row ${t.side}`}>
                  <span className="lt-age num" title={new Date(t.atMs).toLocaleTimeString()}>
                    {sinceText(t.atMs, now)}
                  </span>
                  <span className="lt-side">{t.side === "buy" ? "Buy" : "Sell"}</span>
                  <span
                    className="lt-sol num"
                    title={t.sol === null ? "Traded in another coin, not priced in SOL yet" : undefined}
                  >
                    {t.sol === null ? "–" : solText(t.sol)}
                  </span>
                  <span className="lt-mcap num muted">{t.mcapUsd ? usd(t.mcapUsd) : "–"}</span>
                  <button
                    type="button"
                    className="lt-wallet"
                    title={`Open ${t.wallet}`}
                    onClick={() => openWallet(t.wallet)}
                  >
                    <WalletText wallet={t.wallet} names={names} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

const NO_WALLETS: readonly string[] = [];
