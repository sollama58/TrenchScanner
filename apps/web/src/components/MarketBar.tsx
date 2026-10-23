import {
  Children,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { ApiError } from "../api";
import { usePolling, useNow } from "../hooks";
import { ago, shortAddress, signedPct } from "../format";
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
import { ChartIcon, ChevronDownIcon, LighthouseIcon, PlusIcon, StarIcon, WalletIcon } from "./Icons";

/** Prices move every minute (one shared DexScreener read); the trench sums once an hour. */
const PRICES_POLL_MS = 60_000;
const TRENCH_POLL_MS = 5 * 60_000;
const POSITIONS_POLL_MS = 30_000;
/** The comparison the bar's arrows show; the popover shows all of them. */
const ARROW_HOURS_AGO = 2;
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
  /**
   * The watchlist in the thin bar that stays under the top nav once the full bar has scrolled
   * away: its tokens side by side (market cap and 24h change). Without one, a Watchlist chip that
   * scrolls back up to the full bar.
   */
  leftMini?: ReactNode;
  /** Where the bar reads its figures: "/curated" for subscribers, "/guest" for visitors. */
  base?: "/curated" | "/guest";
}

/**
 * The Live tab's market bar (user ask 2026-10-23), under the top nav: the watchlist on the left,
 * the majors' prices and the trenches' last two hours in the middle, and the wallet's open Pro
 * Mode positions on the right. Three columns on a desktop; the middle over the two sides on a
 * tablet; on a phone the middle alone, with the sides folded into two disclosures under it.
 * Scrolled past, a thin copy (MiniBar) stays pinned under the top nav.
 */
export function MarketBar(props: MarketBarProps) {
  const wallet = useProWallet();
  const guest = (props.base ?? "/curated") === "/guest";
  if (guest) return <Bar {...props} positions={{ kind: "guest" }} />;
  if (!wallet) return <Bar {...props} positions={{ kind: "off" }} />;
  return (
    <PolledPositions wallet={wallet}>
      {(positions) => <Bar {...props} positions={positions} />}
    </PolledPositions>
  );
}

/** The open positions as both bars show them, read once for the two. */
type Positions =
  | { kind: "guest" }
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ok"; open: TradeCoin[] };

function PolledPositions({ wallet, children }: { wallet: string; children: (p: Positions) => ReactNode }) {
  const { data, error } = usePolling<PortfolioTrades>(
    "/pro/trades?view=portfolio",
    POSITIONS_POLL_MS,
    wallet,
  );
  let p: Positions;
  if (data) p = { kind: "ok", open: data.open.filter((c) => !c.closed && c.held > 0) };
  // A wallet the API doesn't count as Pro answers 404: the same as Pro Mode off.
  else if (error instanceof ApiError && error.status === 404) p = { kind: "off" };
  else if (error) p = { kind: "error" };
  else p = { kind: "loading" };
  return <>{children(p)}</>;
}

/** The Portfolio tab, where every position is (the bars show the ones that fit). */
function openPortfolio() {
  window.location.hash = "portfolio";
  window.scrollTo({ top: 0 });
}

/** Whether the reader last left the full bar open; it starts collapsed (user ask 2026-10-23). */
const OPEN_KEY = "ts-market-bar-open";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function Bar({ left, leftMini, base = "/curated", positions }: MarketBarProps & { positions: Positions }) {
  const phone = useMatches(PHONE_QUERY);
  const guest = base === "/guest";
  const prices = usePolling<MarketPrices>(`${base}/market/prices`, PRICES_POLL_MS);
  const trench = usePolling<TrenchAnswer>(`${base}/market/trench`, TRENCH_POLL_MS);
  const [open, setOpenState] = useState(readOpen);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(OPEN_KEY, v ? "1" : "0");
    } catch {
      // A private window: the choice lasts this visit.
    }
  };
  const ref = useRef<HTMLElement>(null);
  const pinned = usePinnedPast(ref, open);
  const watch = left ?? <WatchlistPlaceholder guest={guest} />;
  const posCell = <PositionsCell positions={positions} />;
  const middle = (
    <MiddleCell
      prices={prices.data}
      trench={trench.data}
      trenchFailed={!trench.data && trench.error !== null}
    />
  );
  const miniProps = { watch: leftMini, prices: prices.data, trench: trench.data, positions };
  const full = phone ? (
    <section ref={ref} className="mkt-bar phone" aria-label="Market" id="market-bar">
      {middle}
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
          <div className="mkt-fold-body">{posCell}</div>
        </details>
      </div>
    </section>
  ) : (
    <section ref={ref} className="mkt-bar" aria-label="Market" id="market-bar">
      <div className="mkt-cell mkt-left">{watch}</div>
      {middle}
      <div className="mkt-cell mkt-right">{posCell}</div>
    </section>
  );
  return (
    <>
      {/* Collapsed: the thin bar in the page, sticking under the top nav as the page scrolls (a
          child of the tab's stack, so it sticks the whole way down). */}
      {!open && <MiniBar mode="sticky" shown onExpand={() => setOpen(true)} {...miniProps} />}
      {/* Open: the full bar, folding away into the thin one pinned under the nav once scrolled past. */}
      <div className={`mkt-full-slot${open ? " open" : ""}`} inert={!open}>
        <div>
          {full}
          <button
            type="button"
            className="mkt-collapse"
            onClick={() => setOpen(false)}
            aria-controls="market-bar"
            aria-expanded={open}
            title="Collapse to the thin bar"
          >
            <ChevronDownIcon size={13} className="flip" /> Collapse
          </button>
        </div>
      </div>
      <MiniBar mode="fixed" shown={open && pinned} onExpand={() => scrollToBar(ref.current)} {...miniProps} />
    </>
  );
}

/** The top nav's height, which the pinned bar sits under (it grows on phones with a notch). */
function useTopbarHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const top = document.querySelector<HTMLElement>(".topbar");
    if (!top) return;
    const fit = () => setH(top.offsetHeight);
    fit();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(top);
    return () => ro?.disconnect();
  }, []);
  return h;
}

/** True once the element has scrolled up past the top nav (and only then: not while below the fold). */
function usePinnedPast(ref: React.RefObject<HTMLElement | null>, on: boolean): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) {
      setPast(false);
      return;
    }
    let raf = 0;
    const check = () => {
      raf = 0;
      const top = document.querySelector<HTMLElement>(".topbar")?.offsetHeight ?? 0;
      // Past once all but its last few pixels are under the nav: the thin bar takes over as it leaves.
      setPast(el.getBoundingClientRect().bottom < top + 24);
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.cancelAnimationFrame(raf);
    };
  }, [ref, on]);
  return past;
}

function scrollToBar(el: HTMLElement | null) {
  if (!el) return;
  const top = document.querySelector<HTMLElement>(".topbar")?.offsetHeight ?? 0;
  window.scrollTo({
    top: Math.max(0, window.scrollY + el.getBoundingClientRect().top - top - 12),
    behavior: "smooth",
  });
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

function MiddleCell({
  prices,
  trench,
  trenchFailed,
}: {
  prices: MarketPrices | null;
  trench: TrenchAnswer | null;
  trenchFailed: boolean;
}) {
  return (
    <div className="mkt-cell mkt-mid">
      <div className="mkt-prices" role="list" aria-label="Prices">
        {(prices?.prices ?? PLACEHOLDER_TICKERS).map((p) => (
          <Ticker key={p.symbol} p={p} loading={!prices} />
        ))}
      </div>
      <TrenchStats data={trench} failed={trenchFailed} />
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
                    {data ? statText(s, now) : failed ? "–" : <span className="skeleton mkt-skel" />}
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
                <td className="num now">{statText(s, now)}</td>
                {data.compare.map((c) => {
                  const then = c.stats[s.key];
                  const d = statDelta(s, now, then);
                  return (
                    <td
                      key={c.hoursAgo}
                      className={`num mkt-delta ${d.tone ?? ""}`}
                      title={`${hhmm(c.from)}–${hhmm(c.to)}: ${statText(s, then)}`}
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
                      <span className="mkt-delta-then">{statText(s, then)}</span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mkt-pop-foot faint">
        {cur.samples.graded} graded calls · {cur.samples.screened.toLocaleString()} tokens screened. Rates
        need {data.minSample}+ graded calls; the newest hours keep grading for an hour.
      </p>
    </div>
  );
}

// ---------- Right: open positions ----------

interface PortfolioTrades {
  open: TradeCoin[];
  openTotal: number;
}

/** How many open positions the full bar's cell has room for; the rest are a "+N" to Portfolio. */
const POSITIONS_SHOWN = 3;

function PositionsCell({ positions }: { positions: Positions }) {
  const more = positions.kind === "ok" ? Math.max(0, positions.open.length - POSITIONS_SHOWN) : 0;
  return (
    <div className="mkt-pane">
      <header className="mkt-head">
        <span className="eyebrow">
          <WalletIcon size={12} /> Open positions
          {positions.kind === "ok" && positions.open.length > 0 && (
            <span className="mkt-count num">{positions.open.length}</span>
          )}
        </span>
        {(positions.kind === "ok" || positions.kind === "loading" || positions.kind === "error") && (
          <MoreButton
            more={more}
            onClick={openPortfolio}
            title="Open Portfolio: every position, with its trades"
          />
        )}
      </header>
      {positions.kind === "guest" ? (
        <Empty
          title="Sign in to see your positions"
          text="With Pro Mode on, the coins you hold show here with their live PnL."
        />
      ) : positions.kind === "off" ? (
        <ProOff />
      ) : (
        <PositionsList positions={positions} />
      )}
    </div>
  );
}

/** "+3" when there are more than show, a bare "+" otherwise: either way, to the full list. */
function MoreButton({ more, onClick, title }: { more: number; onClick: () => void; title: string }) {
  return (
    <button type="button" className={`mkt-more${more > 0 ? " has" : ""}`} onClick={onClick} title={title}>
      <PlusIcon size={12} />
      {more > 0 && <span className="num">{more}</span>}
    </button>
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

function PositionsList({ positions }: { positions: Positions }) {
  const now = useNow(30_000);
  if (positions.kind === "error")
    return (
      <Empty
        title="Positions unavailable"
        text="Couldn't load your positions just now. They'll be back on the next refresh."
      />
    );
  if (positions.kind !== "ok")
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
  const { open } = positions;
  if (open.length === 0)
    return <Empty title="No open positions" text="Coins you buy show up here with their live PnL." />;
  return (
    <ul className="mkt-pos" aria-label={`${open.length} open position${open.length === 1 ? "" : "s"}`}>
      {open.slice(0, POSITIONS_SHOWN).map((c) => (
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

// ---------- The thin bar, pinned under the top nav once the full one scrolls away ----------

/** The 24h change's tone, for a price's colour in the thin bar. */
const chgTone = (v: number | null) => (v === null || Math.abs(v) < 0.05 ? "" : v > 0 ? " up" : " down");

function MiniBar({
  mode,
  shown,
  onExpand,
  watch,
  prices,
  trench,
  positions,
}: {
  /** "sticky": the collapsed bar, in the page; "fixed": over the page once the full bar has scrolled away. */
  mode: "sticky" | "fixed";
  shown: boolean;
  /** Open the full bar (or, pinned, scroll back up to it). */
  onExpand: () => void;
  watch?: ReactNode;
  prices: MarketPrices | null;
  trench: TrenchAnswer | null;
  positions: Positions;
}) {
  const topbar = useTopbarHeight();
  const onTop = onExpand;
  const vs = trench?.compare.find((c) => c.hoursAgo === ARROW_HOURS_AGO) ?? null;
  const stat = (key: "hit2xPct" | "avgReturnPct", label: string) => {
    const s = TRENCH_STATS.find((t) => t.key === key)!;
    const now = trench?.current.stats[key] ?? null;
    const d = statDelta(s, now, vs?.stats[key] ?? null);
    return (
      <span className="mkt-mini-stat" title={`${s.title}: ${deltaWords(d, ARROW_HOURS_AGO)}`}>
        <span className="mkt-mini-label">{label}</span>
        <span className="num">{statText(s, now)}</span>
        <Arrow d={d} />
      </span>
    );
  };
  return (
    <div
      className={`mkt-mini ${mode}${shown ? " on" : ""}`}
      // In the page it keeps a little air under the nav; pinned, its own padding does.
      style={{ top: mode === "sticky" ? topbar + 8 : topbar }}
      aria-hidden={!shown}
      inert={!shown}
      role="region"
      aria-label="Market, pinned"
    >
      <div className="mkt-mini-inner">
        <div className="mkt-mini-scroll">
          <div className="mkt-mini-group mkt-mini-watch">
            {watch ?? (
              <button
                type="button"
                className="mkt-mini-chip ghost"
                onClick={onTop}
                title="Back to the market bar"
              >
                <StarIcon size={12} /> Watchlist
              </button>
            )}
          </div>
          <span className="mkt-mini-sep" aria-hidden />
          <button
            type="button"
            className="mkt-mini-group mkt-mini-mid"
            onClick={onTop}
            title="Back to the full market bar"
          >
            {(prices?.prices ?? PLACEHOLDER_TICKERS).map((p) => (
              <span
                key={p.symbol}
                className="mkt-mini-price"
                title={`${p.symbol}: 24h ${signedPct(p.change24hPct, 1)}`}
              >
                <TokenImage
                  url={p.imageUrl}
                  size={32}
                  width={16}
                  height={16}
                  className="mkt-logo"
                  fallback={
                    <span className={`mkt-logo mono t-${p.symbol.toLowerCase()}`}>
                      {p.symbol === "BTC" ? "₿" : p.symbol.slice(0, 1)}
                    </span>
                  }
                />
                <span className={`num${chgTone(p.change24hPct)}`}>
                  {prices ? priceText(p.priceUsd) : "–"}
                </span>
              </span>
            ))}
            <span className="mkt-mini-sep" aria-hidden />
            {stat("hit2xPct", "2x")}
            {stat("avgReturnPct", "Avg")}
          </button>
          {positions.kind !== "guest" && positions.kind !== "off" && (
            <>
              <span className="mkt-mini-sep" aria-hidden />
              <div className="mkt-mini-group mkt-mini-pos">
                <WalletIcon size={12} className="mkt-mini-icon" />
                {positions.kind === "ok" ? (
                  positions.open.length > 0 ? (
                    <FitRow
                      more={(n) => (
                        <MoreButton more={n} onClick={openPortfolio} title="Open Portfolio: every position" />
                      )}
                    >
                      {positions.open.map((c) => (
                        <MiniPosition key={c.mint} c={c} />
                      ))}
                    </FitRow>
                  ) : (
                    <span className="faint mkt-mini-none">No open positions</span>
                  )
                ) : (
                  <span className="skeleton mkt-skel" />
                )}
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          className="mkt-mini-expand"
          onClick={onExpand}
          aria-controls="market-bar"
          aria-expanded={false}
          title={mode === "sticky" ? "Expand the market bar" : "Back to the full market bar"}
        >
          <ChevronDownIcon size={14} />
        </button>
      </div>
    </div>
  );
}

function MiniPosition({ c }: { c: TradeCoin }) {
  const label = c.symbol ? `$${c.symbol}` : shortAddress(c.mint);
  const card = c.card;
  const mcap = card?.currentMarketCapUsd ?? null;
  return (
    <button
      type="button"
      className="mkt-mini-chip"
      onClick={() => card && openTokenModal(card, Date.now())}
      disabled={!card}
      title={`${label}: ${signedPct(c.pnlPct, 1)} · ${solText(c.pnlSol)}`}
    >
      <TokenImage
        url={c.imageUrl}
        size={32}
        width={16}
        height={16}
        className="avatar mkt-mini-img"
        fallback={<span className="avatar mkt-mini-img placeholder">{(c.symbol ?? "?").slice(0, 1)}</span>}
      />
      <span className="num">{mcap !== null ? usd(mcap) : label}</span>
      <span className={`num mkt-mini-pct${tone(c.pnlPct)}`}>{signedPct(c.pnlPct, 0)}</span>
    </button>
  );
}

/**
 * A row of chips that shows as many as fit its width whole, then `more(hidden)`: measured after
 * layout and again on resize, so a chip is never cut or wrapped.
 */
export function FitRow({ children, more }: { children: ReactNode; more: (hidden: number) => ReactNode }) {
  const items = Children.toArray(children);
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(items.length);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    const measure = () => {
      // Hidden chips are taken out of the flow but keep their size, so every width is known.
      const kids = [...row.querySelectorAll<HTMLElement>(":scope > .fit-item")];
      const moreEl = row.querySelector<HTMLElement>(":scope > .fit-more");
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const room = row.clientWidth - (moreEl?.offsetWidth ?? 0) - gap;
      let used = 0;
      let n = 0;
      for (const k of kids) {
        const next = used + (n > 0 ? gap : 0) + k.offsetWidth;
        if (next > room && n > 0) break;
        used = next;
        n++;
      }
      setFit(n);
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(row);
    return () => ro?.disconnect();
  }, [items.length]);
  return (
    <div className="fit-row" ref={ref}>
      {items.map((it, i) => (
        <span key={i} className={`fit-item${i < fit ? "" : " hidden"}`} aria-hidden={i >= fit}>
          {it}
        </span>
      ))}
      <span className="fit-more">{more(items.length - fit)}</span>
    </div>
  );
}
