import { useEffect, useRef, useState } from "react";
import type { Card } from "../api";
import { usePolling } from "../hooks";
import { ago, change, pct, shortAddress, signedPct, usd } from "../format";
import { openTokenModal } from "../tokenModal";
import { TokenImage } from "./TokenImage";
import { BrainIcon, ChartIcon, ChevronDownIcon, CloseIcon } from "./Icons";

/** Wide enough for the panel's card grid; phones and narrow windows don't get it, as with Utility. */
const DESKTOP_QUERY = "(min-width: 900px)";
/** The closed handle's pictures, and the open panel's cards and figures (the API reuses an answer 8 s). */
const HANDLE_POLL_MS = 60_000;
const PANEL_POLL_MS = 15_000;

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

interface HandleView {
  coins: { mint: string; symbol: string | null; imageUrl: string | null; closed: boolean; entryAt: string }[];
}

export interface TradeCoin {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  entryAt: string;
  lastTradeAt: string;
  buys: number;
  sells: number;
  spentSol: number;
  gotSol: number;
  held: number;
  closed: boolean;
  entryMcapUsd: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  calledBefore: { at: string; modelName: string | null; confidence: number } | null;
  card: Card | null;
  scan: "scanning" | "scanned" | "none";
}

export interface TradeStats {
  hours: number;
  trades: number;
  buys: number;
  sells: number;
  coins: number;
  volumeSol: number;
  closed: number;
  open: number;
  winRatePct: number | null;
  realizedSol: number;
  unrealizedSol: number | null;
  bestMultiple: number | null;
  medianHoldMinutes: number | null;
  calledFirst: number;
  entries: number;
}

interface PanelView {
  coins: TradeCoin[];
  stats: TradeStats;
  solUsd: number | null;
}

/**
 * The TRADES panel (user ask 2026-10-18): for a Pro Mode wallet, a "TRADES" handle on the right
 * edge above the Utility one, showing the last three coins it bought, that pulls out its last ten
 * trades as small cards - each coin already scanned, so its token modal opens with the bubble map
 * ready - and its last 24 hours' trade figures. Its trades are read from the chain wherever they were made
 * (routes/proTrades.ts in the API). Desktop only, as the Utility panel is.
 */
export function TradesDrawer() {
  const desktop = useMatches(DESKTOP_QUERY);
  if (!desktop) return null;
  return <Drawer />;
}

function Drawer() {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const handle = usePolling<HandleView>("/pro/trades?brief=1", HANDLE_POLL_MS);
  const coins = handle.data?.coins ?? [];

  useEffect(() => {
    if (!open) return;
    const aside = ref.current;
    // A popup over the panel (a coin's token modal) takes Escape and clicks for itself.
    const inPopup = () => document.querySelector("dialog[open]") !== null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !inPopup()) {
        setOpen(false);
        aside?.querySelector<HTMLButtonElement>(".trades-drawer-handle")?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || inPopup() || aside?.contains(target)) return;
      if (target instanceof Element && target.closest("dialog")) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <aside ref={ref} className={`trades-drawer${open ? " open" : ""}`} aria-label="Trades panel">
      <button
        type="button"
        className="trades-drawer-handle"
        aria-expanded={open}
        aria-controls="trades-drawer-panel"
        title={open ? "Close your trades" : "Your last trades, each coin scanned"}
        onClick={() => {
          setOpened(true);
          setOpen((o) => !o);
        }}
      >
        <ChartIcon size={18} />
        <span className="trades-drawer-handle-text">Trades</span>
        {coins.length > 0 && (
          <span className="trades-handle-coins" aria-hidden="true">
            {coins.map((c) => (
              <TokenImage
                key={c.mint}
                url={c.imageUrl}
                size={48}
                width={24}
                height={24}
                className={`trades-handle-coin${c.closed ? " closed" : ""}`}
                fallback={
                  <span className="trades-handle-coin placeholder">{(c.symbol ?? "?").slice(0, 2)}</span>
                }
              />
            ))}
          </span>
        )}
        <ChevronDownIcon size={16} className="trades-drawer-chev" />
      </button>
      <div id="trades-drawer-panel" className="trades-drawer-panel" inert={!open}>
        {opened && <PanelBody open={open} onClose={() => setOpen(false)} />}
      </div>
    </aside>
  );
}

function PanelBody({ open, onClose }: { open: boolean; onClose: () => void }) {
  // `open=1` keeps the open coins on the scan while the panel is out, so their Now moves.
  const { data, error } = usePolling<PanelView>(
    `/pro/trades${open ? "?open=1" : ""}`,
    open ? PANEL_POLL_MS : HANDLE_POLL_MS * 5,
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <header className="util-drawer-head trades-drawer-head">
        <div>
          <span className="eyebrow">
            <ChartIcon size={13} /> Trades
          </span>
          <h2>Your last trades</h2>
        </div>
        <div className="drawer-actions">
          <span className="faint small trades-live">
            <span className="trades-live-dot" /> Following this wallet
          </span>
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close your trades">
            <CloseIcon size={16} />
          </button>
        </div>
      </header>
      {error && !data && (
        <p className="error small util-drawer-error" role="alert">
          Couldn&apos;t load your trades: {error.message}
        </p>
      )}
      {data && <StatsStrip stats={data.stats} solUsd={data.solUsd} />}
      <div className="trades-grid-wrap">
        {!data ? (
          !error && <p className="faint small trades-empty">Loading…</p>
        ) : data.coins.length === 0 ? (
          <p className="faint small trades-empty">
            No trades yet. Buy a coin with this wallet, here or anywhere else, and it shows up here within
            seconds, already scanned.
          </p>
        ) : (
          <ul className="trades-grid">
            {data.coins.map((c) => (
              <li key={c.mint}>
                <TradeCard coin={c} now={now} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function sol(n: number | null | undefined, signed = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  const text = abs >= 100 ? abs.toFixed(0) : abs >= 10 ? abs.toFixed(1) : abs.toFixed(2);
  if (!signed) return `${text} SOL`;
  if (Number(text) === 0) return `0 SOL`;
  return `${n > 0 ? "+" : "-"}${text} SOL`;
}

function minutes(m: number | null): string {
  if (m === null) return "–";
  if (m < 1) return "<1m";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 48 * 60) return `${(m / 60).toFixed(m < 600 ? 1 : 0)}h`;
  return `${Math.round(m / 1440)}d`;
}

const tone = (n: number | null | undefined) =>
  n === null || n === undefined || n === 0 ? "" : n > 0 ? " up" : " down";

/** The last 24 hours' figures across every trade, open and closed. */
function StatsStrip({ stats, solUsd }: { stats: TradeStats; solUsd: number | null }) {
  const usdOf = (n: number | null) => (n !== null && solUsd ? usd(n * solUsd) : null);
  const tiles: { label: string; value: string; sub?: string | null; tone?: string; title: string }[] = [
    {
      label: "Trades",
      value: String(stats.trades),
      sub: `${stats.coins} coin${stats.coins === 1 ? "" : "s"} · ${stats.buys} buys`,
      title: `${stats.buys} buys and ${stats.sells} sales in ${stats.coins} coins: what this wallet traded in the last ${stats.hours} hours, wherever it traded`,
    },
    {
      label: "Win rate",
      value: pct(stats.winRatePct),
      sub: stats.closed > 0 ? `of ${stats.closed} closed` : "none closed yet",
      title: "Of the trades sold out of, the share that got back more SOL than they spent (fees included)",
    },
    {
      label: "Realized",
      value: sol(stats.realizedSol, true),
      sub: usdOf(stats.realizedSol),
      tone: tone(stats.realizedSol),
      title: "What the closed trades made or lost together, in SOL, fees included",
    },
    {
      label: "Open",
      value: stats.unrealizedSol === null ? "–" : sol(stats.unrealizedSol, true),
      sub: `${stats.open} holding`,
      tone: tone(stats.unrealizedSol),
      title: "What the coins still held would make or lose if sold at their latest price",
    },
    {
      label: "Best",
      value:
        stats.bestMultiple === null
          ? "–"
          : `${stats.bestMultiple.toFixed(stats.bestMultiple >= 10 ? 0 : 2)}x`,
      sub: `median hold ${minutes(stats.medianHoldMinutes)}`,
      title:
        "The best closed trade, as a multiple of the SOL it spent; and the middle closed trade's time held",
    },
    {
      label: "Alerted first",
      value: stats.entries > 0 ? `${stats.calledFirst}/${stats.entries}` : "–",
      sub: "before your buy",
      title:
        "Of the coins you bought into, how many a TrenchScanner model had already alerted on before your buy",
    },
  ];
  return (
    <dl className="trades-stats" aria-label={`Your trades, last ${stats.hours} hours`}>
      {tiles.map((t) => (
        <div key={t.label} className="trades-stat" title={t.title}>
          <dt>{t.label}</dt>
          <dd className={`num${t.tone ?? ""}`}>{t.value}</dd>
          {t.sub && <dd className="faint trades-stat-sub">{t.sub}</dd>}
        </div>
      ))}
      <div className="trades-stat trades-stat-window faint">{stats.hours}h</div>
    </dl>
  );
}

/** One coin traded, as a small alert card: entry, now, the trade's result, and the scan. */
function TradeCard({ coin, now }: { coin: TradeCoin; now: number }) {
  const card = coin.card;
  const nowMcap = card?.currentMarketCapUsd ?? null;
  const move = change(coin.entryMcapUsd, nowMcap);
  const label = coin.symbol ? `$${coin.symbol}` : shortAddress(coin.mint);
  const openIt = () => {
    if (card) openTokenModal(card, now);
  };
  const scanText =
    coin.scan === "scanned" ? "Scanned" : coin.scan === "scanning" ? "Scanning…" : "Not scanned";
  return (
    <article
      className={`card compact trade-card${card ? " opens" : ""}${coin.closed ? " closed" : ""}`}
      onClick={openIt}
      title={card ? `${label}: open the chart, bubble map and details` : "This coin had no market to scan"}
    >
      <header className="card-head">
        <div
          className={`avatar-wrap tone-${coin.pnlPct === null ? "neutral" : coin.pnlPct >= 0 ? "good" : "bad"}`}
        >
          <TokenImage
            url={coin.imageUrl}
            size={72}
            width={34}
            height={34}
            className="avatar trade-avatar"
            fallback={
              <span className="avatar trade-avatar placeholder">{(coin.symbol ?? "?").slice(0, 2)}</span>
            }
          />
        </div>
        <div className="card-title">
          <div className="title-row">
            <strong className="symbol" title={coin.name ?? label}>
              {label}
            </strong>
            {coin.calledBefore && (
              <span
                className="trade-called"
                role="img"
                aria-label="TrenchScanner alerted on it before your buy"
                title={`${coin.calledBefore.modelName ?? "A model"} alerted on it ${minutes((Date.parse(coin.entryAt) - Date.parse(coin.calledBefore.at)) / 60_000)} before your buy, score ${coin.calledBefore.confidence.toFixed(0)}`}
              >
                <BrainIcon size={12} />
              </span>
            )}
          </div>
          <div className="meta-row">
            <span className={`pill trade-state${coin.closed ? "" : " holding"}`}>
              <span className="pill-text">{coin.closed ? "Sold" : "Holding"}</span>
            </span>
            <span className="when" title={new Date(coin.entryAt).toLocaleString()}>
              {ago(coin.entryAt, now)}
            </span>
          </div>
        </div>
      </header>
      <div className="card-figures" style={{ "--fig-cols": 2 } as React.CSSProperties}>
        <div className="fig">
          <label>Entry</label>
          <span className="num">{usd(coin.entryMcapUsd)}</span>
        </div>
        <div className="fig">
          <label>Now</label>
          <span className="num">{usd(nowMcap)}</span>
          {move !== null && (
            <small className={`num delta ${move >= 0 ? "up" : "down"}`}>
              {move >= 0 ? "▲" : "▼"} {pct(Math.abs(move))}
            </small>
          )}
        </div>
      </div>
      <div
        className="trade-result"
        title="Your result: SOL back plus what is still held at the latest price, less SOL spent (fees included)"
      >
        <span className={`num trade-pnl${tone(coin.pnlSol)}`}>{sol(coin.pnlSol, true)}</span>
        <span className={`num trade-pnl-pct${tone(coin.pnlPct)}`}>{signedPct(coin.pnlPct)}</span>
      </div>
      <div className="trade-foot">
        <span
          className="faint num"
          title={`${coin.buys} buy${coin.buys === 1 ? "" : "s"}, ${coin.sells} sale${coin.sells === 1 ? "" : "s"}`}
        >
          {sol(coin.spentSol)} in
        </span>
        <span className={`faint trade-scan ${coin.scan}`}>{scanText}</span>
      </div>
    </article>
  );
}
