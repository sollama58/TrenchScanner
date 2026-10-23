import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { ApiError } from "../api";
import { usePolling, useNow } from "../hooks";
import { ago, shortAddress, signedPct, usd } from "../format";
import { openTokenModal } from "../tokenModal";
import { useProWallet } from "../proTrade";
import {
  deltaText,
  priceText,
  statDelta,
  statText,
  TRENCH_STATS,
  type MarketPrice,
  type MarketPrices,
  type StatDelta,
  type TrenchAnswer,
} from "../marketBar";
import type { TradeCoin } from "./TradesDrawer";
import { TokenImage } from "./TokenImage";
import { ChartIcon, ChevronDownIcon, LighthouseIcon, StarIcon, WalletIcon } from "./Icons";

/** Prices move every minute (one shared DexScreener read); the trench sums once an hour. */
const PRICES_POLL_MS = 60_000;
const TRENCH_POLL_MS = 5 * 60_000;
const POSITIONS_POLL_MS = 30_000;
/** The comparison the bar's arrows show; the popover shows all of them. */
const ARROW_HOURS_AGO = 6;
/** Phones get the prices and trench stats, with the side panels folded away. */
const PHONE_QUERY = "(max-width: 640px)";

function useMatches(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const sync = () => setMatches(list.matches);
    sync();
    list.addEventListener("change", sync);
    return () => list.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

export interface MarketBarProps {
  /**
   * The left third: the reader's watchlist (WatchlistPanel). Without one, a placeholder card holds
   * its place at the same height.
   */
  left?: ReactNode;
  /** Where the bar reads its figures: "/curated" for subscribers, "/guest" for visitors. */
  base?: "/curated" | "/guest";
}

/**
 * The Live tab's market bar (user ask 2026-10-23), under the top nav: the watchlist on the left,
 * the majors' prices and the trenches' last two hours in the middle, and the wallet's open Pro
 * Mode positions on the right. Three columns on a desktop; the middle over the two sides on a
 * tablet; on a phone the middle alone, with the sides folded into two disclosures under it.
 */
export function MarketBar({ left, base = "/curated" }: MarketBarProps) {
  const phone = useMatches(PHONE_QUERY);
  const guest = base === "/guest";
  const watch = left ?? <WatchlistPlaceholder guest={guest} />;
  const positions = <PositionsCell guest={guest} />;
  if (phone) {
    return (
      <section className="mkt-bar phone" aria-label="Market">
        <MiddleCell base={base} />
        <div className="mkt-folds">
          <details className="mkt-fold">
            <summary>
              <StarIcon size={13} /> Watchlist <ChevronDownIcon size={13} className="mkt-fold-chev" />
            </summary>
            <div className="mkt-fold-body">{watch}</div>
          </details>
          <details className="mkt-fold">
            <summary>
              <WalletIcon size={13} /> Positions <ChevronDownIcon size={13} className="mkt-fold-chev" />
            </summary>
            <div className="mkt-fold-body">{positions}</div>
          </details>
        </div>
      </section>
    );
  }
  return (
    <section className="mkt-bar" aria-label="Market">
      <div className="mkt-cell mkt-left">{watch}</div>
      <MiddleCell base={base} />
      <div className="mkt-cell mkt-right">{positions}</div>
    </section>
  );
}

// ---------- Left: the watchlist's slot ----------

function WatchlistPlaceholder({ guest }: { guest: boolean }) {
  return (
    <div className="mkt-pane">
      <header className="mkt-head">
        <span className="eyebrow">
          <StarIcon size={12} /> Watchlist
        </span>
      </header>
      <div className="mkt-empty">
        <div className="mkt-ghost" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <p>
          <strong>{guest ? "Sign in to keep a watchlist" : "Nothing watched yet"}</strong>
          <span className="faint">
            {guest
              ? "Star tokens to follow their price and market cap here."
              : "Star tokens to watch them here, with their price and market cap."}
          </span>
        </p>
      </div>
    </div>
  );
}

// ---------- Middle: prices and the trenches ----------

function MiddleCell({ base }: { base: string }) {
  const prices = usePolling<MarketPrices>(`${base}/market/prices`, PRICES_POLL_MS);
  const trench = usePolling<TrenchAnswer>(`${base}/market/trench`, TRENCH_POLL_MS);
  return (
    <div className="mkt-cell mkt-mid">
      <div className="mkt-prices" role="list" aria-label="Prices">
        {(prices.data?.prices ?? PLACEHOLDER_TICKERS).map((p) => (
          <Ticker key={p.symbol} p={p} loading={!prices.data} />
        ))}
      </div>
      <TrenchStats data={trench.data} failed={!trench.data && trench.error !== null} />
    </div>
  );
}

const PLACEHOLDER_TICKERS: MarketPrice[] = ["BTC", "SOL", "PUMP", "STONK"].map((symbol) => ({
  symbol,
  mint: symbol,
  priceUsd: null,
  change6hPct: null,
  change24hPct: null,
  imageUrl: null,
}));

function Change({ label, v }: { label: string; v: number | null }) {
  const dir = v === null || Math.abs(v) < 0.05 ? "" : v > 0 ? " up" : " down";
  return (
    <span className={`mkt-chg${dir}`}>
      <span className="mkt-chg-label">{label}</span>
      <span className="num">{signedPct(v, 1)}</span>
    </span>
  );
}

function Ticker({ p, loading }: { p: MarketPrice; loading: boolean }) {
  return (
    <div
      className="mkt-ticker"
      role="listitem"
      title={
        p.symbol === "BTC"
          ? "Bitcoin, priced from cbBTC on Solana (DexScreener)"
          : `${p.symbol} on Solana (DexScreener)`
      }
    >
      <div className="mkt-ticker-top">
        <TokenImage
          url={p.imageUrl}
          size={40}
          width={18}
          height={18}
          className="mkt-logo"
          fallback={
            <span className={`mkt-logo mono t-${p.symbol.toLowerCase()}`}>
              {p.symbol === "BTC" ? "₿" : p.symbol.slice(0, 1)}
            </span>
          }
        />
        <span className="mkt-sym">{p.symbol}</span>
        <span className="num mkt-price">
          {loading ? <span className="skeleton mkt-skel" /> : priceText(p.priceUsd)}
        </span>
      </div>
      <div className="mkt-ticker-chg">
        <Change label="6h" v={p.change6hPct} />
        <Change label="24h" v={p.change24hPct} />
      </div>
    </div>
  );
}

/** "13:00": the windows start and end on the hour, so a 24-hour clock keeps the label short. */
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function Arrow({ d }: { d: StatDelta }) {
  if (d.dir === null || d.dir === "flat")
    return (
      <span className="mkt-arrow flat" aria-hidden>
        –
      </span>
    );
  return (
    <span className={`mkt-arrow ${d.tone ?? ""}`} aria-hidden>
      {d.dir === "up" ? "▲" : "▼"}
    </span>
  );
}

function deltaWords(d: StatDelta, hoursAgo: number): string {
  if (d.value === null) return `no comparison with ${hoursAgo}h ago`;
  if (d.dir === "flat") return `about the same as ${hoursAgo}h ago`;
  return `${d.dir === "up" ? "up" : "down"} ${deltaText(d)} on ${hoursAgo}h ago`;
}

/**
 * The trenches' last two summed hours, each stat with its move against the same two hours six
 * hours earlier. Hover, focus or tap opens the in-depth view: every stat against 2, 6, 24 and 48
 * hours ago.
 */
function TrenchStats({ data, failed }: { data: TrenchAnswer | null; failed: boolean }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popId = useId();
  const shown = open || pinned;

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setPinned(false);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        setOpen(false);
        setPinned(false);
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [shown]);

  const vs = data?.compare.find((c) => c.hoursAgo === ARROW_HOURS_AGO) ?? null;
  const toggle = () => setPinned((p) => !p);
  return (
    <div
      ref={ref}
      className={`mkt-trench${shown ? " open" : ""}`}
      onMouseEnter={(e) => {
        if (e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType === "touch") return;
        setOpen(true);
      }}
      onMouseLeave={() => setOpen(false)}
    >
      <div
        className="mkt-trench-face"
        role="button"
        tabIndex={0}
        aria-expanded={shown}
        aria-controls={popId}
        aria-label="Trench stats for the last two hours. Open the comparison with earlier windows."
        onClick={toggle}
        onKeyDown={(e: ReactKeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          toggle();
        }}
      >
        <header className="mkt-head">
          <span className="eyebrow">
            <LighthouseIcon size={12} /> Trench stats
            <span className="mkt-window">
              {data
                ? `last ${data.windowHours}h · ${hhmm(data.current.from)}–${hhmm(data.current.to)}`
                : "last 2h"}
            </span>
          </span>
          <span className="mkt-vs faint">vs {ARROW_HOURS_AGO}h ago</span>
        </header>
        <dl className="mkt-stats">
          {TRENCH_STATS.map((s) => {
            const now = data?.current.stats[s.key] ?? null;
            const d = statDelta(s, now, vs?.stats[s.key] ?? null);
            return (
              <div key={s.key} className="mkt-stat" title={`${s.title}: ${deltaWords(d, ARROW_HOURS_AGO)}`}>
                <dt>{s.label}</dt>
                <dd>
                  <span className="num mkt-stat-v">
                    {data ? statText(s, now, usd) : failed ? "–" : <span className="skeleton mkt-skel" />}
                  </span>
                  {data && <Arrow d={d} />}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
      {shown && data && <TrenchPopover id={popId} data={data} />}
    </div>
  );
}

function TrenchPopover({ id, data }: { id: string; data: TrenchAnswer }) {
  const cur = data.current;
  return (
    <div className="mkt-pop" id={id} role="tooltip">
      <div className="mkt-pop-head">
        <div>
          <strong>The trenches, last {data.windowHours} hours</strong>
          <span className="faint">
            {hhmm(cur.from)}–{hhmm(cur.to)}, against the same {data.windowHours} hours earlier
          </span>
        </div>
      </div>
      <table className="mkt-pop-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col" className="now">
              Now
            </th>
            {data.compare.map((c) => (
              <th scope="col" key={c.hoursAgo} title={`${hhmm(c.from)}–${hhmm(c.to)}`}>
                vs {c.hoursAgo}h
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TRENCH_STATS.map((s) => {
            const now = cur.stats[s.key];
            return (
              <tr key={s.key}>
                <th scope="row" title={s.title}>
                  {s.label}
                </th>
                <td className="num now">{statText(s, now, usd)}</td>
                {data.compare.map((c) => {
                  const then = c.stats[s.key];
                  const d = statDelta(s, now, then);
                  return (
                    <td
                      key={c.hoursAgo}
                      className={`num mkt-delta ${d.tone ?? ""}`}
                      title={`${hhmm(c.from)}–${hhmm(c.to)}: ${statText(s, then, usd)}`}
                    >
                      {d.dir === null ? (
                        <span className="faint">–</span>
                      ) : d.dir === "flat" ? (
                        <span className="faint">≈</span>
                      ) : (
                        <>
                          <span className="mkt-delta-arrow">{d.dir === "up" ? "▲" : "▼"}</span>
                          {deltaText(d)}
                        </>
                      )}
                      <span className="mkt-delta-then">{statText(s, then, usd)}</span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mkt-pop-foot faint">
        {cur.samples.graded} graded calls · {cur.samples.screened.toLocaleString()} tokens screened
        {cur.samples.volumeTokens !== null ? ` · ${cur.samples.volumeTokens.toLocaleString()} trading` : ""}.
        Rates need {data.minSample}+ graded calls; the newest hours keep grading for an hour.
      </p>
    </div>
  );
}

// ---------- Right: open positions ----------

interface PortfolioTrades {
  open: TradeCoin[];
  openTotal: number;
}

function PositionsCell({ guest }: { guest: boolean }) {
  const wallet = useProWallet();
  return (
    <div className="mkt-pane">
      <header className="mkt-head">
        <span className="eyebrow">
          <WalletIcon size={12} /> Open positions
        </span>
      </header>
      {guest ? (
        <Empty
          title="Sign in to see your positions"
          text="With Pro Mode on, the coins you hold show here with their live PnL."
        />
      ) : wallet ? (
        <PositionsList wallet={wallet} />
      ) : (
        <ProOff />
      )}
    </div>
  );
}

function ProOff() {
  return (
    <Empty
      title="Pro Mode is off"
      text="Turn on Pro Mode in Settings to trade from here; your open positions will show with their PnL."
    />
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="mkt-empty">
      <span className="mkt-empty-icon" aria-hidden>
        <ChartIcon size={16} />
      </span>
      <p>
        <strong>{title}</strong>
        <span className="faint">{text}</span>
      </p>
    </div>
  );
}

const tone = (n: number | null) => (n === null || n === 0 ? "" : n > 0 ? " up" : " down");
const solText = (n: number | null) =>
  n === null
    ? "–"
    : `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n) >= 10 ? Math.abs(n).toFixed(1) : Math.abs(n).toFixed(2)} SOL`;

function PositionsList({ wallet }: { wallet: string }) {
  const { data, error } = usePolling<PortfolioTrades>(
    "/pro/trades?view=portfolio",
    POSITIONS_POLL_MS,
    wallet,
  );
  const now = useNow(30_000);
  if (!data) {
    // A wallet the API doesn't count as Pro answers 404: the same as Pro Mode off.
    if (error instanceof ApiError && error.status === 404) return <ProOff />;
    if (error)
      return (
        <Empty
          title="Positions unavailable"
          text="Couldn't load your positions just now. They'll be back on the next refresh."
        />
      );
    return (
      <ul className="mkt-pos">
        {[0, 1, 2].map((i) => (
          <li key={i} className="mkt-pos-row skel">
            <span className="skeleton round" style={{ width: 28, height: 28 }} />
            <span className="skeleton" style={{ width: "40%", height: 12 }} />
          </li>
        ))}
      </ul>
    );
  }
  const open = data.open.filter((c) => !c.closed && c.held > 0);
  if (open.length === 0)
    return <Empty title="No open positions" text="Coins you buy show up here with their live PnL." />;
  return (
    <ul className="mkt-pos" aria-label={`${open.length} open position${open.length === 1 ? "" : "s"}`}>
      {open.map((c) => (
        <Position key={c.mint} c={c} now={now} />
      ))}
    </ul>
  );
}

function Position({ c, now }: { c: TradeCoin; now: number }) {
  const label = c.symbol ? `$${c.symbol}` : shortAddress(c.mint);
  const card = c.card;
  const openIt = () => {
    if (card) openTokenModal(card, now);
  };
  return (
    <li>
      <button
        type="button"
        className="mkt-pos-row"
        onClick={openIt}
        disabled={!card}
        title={card ? `${label}: open the chart and details` : "This coin had no market to scan"}
      >
        <TokenImage
          url={c.imageUrl}
          size={56}
          width={28}
          height={28}
          className="avatar mkt-pos-img"
          fallback={<span className="avatar mkt-pos-img placeholder">{(c.symbol ?? "?").slice(0, 2)}</span>}
        />
        <span className="mkt-pos-name">
          <strong>{label}</strong>
          <span className="faint">{ago(c.entryAt, now)}</span>
        </span>
        <span className="mkt-pos-pnl">
          <span className={`num mkt-pos-pct${tone(c.pnlPct)}`}>{signedPct(c.pnlPct, 1)}</span>
          <span className={`num mkt-pos-sol${tone(c.pnlSol)}`}>{solText(c.pnlSol)}</span>
        </span>
      </button>
    </li>
  );
}
