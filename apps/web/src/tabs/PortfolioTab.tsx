import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Card } from "../api";
import { Skeleton } from "../components/Charts";
import {
  ChartIcon,
  CloseIcon,
  GiftIcon,
  InfoIcon,
  RobotIcon,
  TransferIcon,
  WalletIcon,
} from "../components/Icons";
import { TokenImage } from "../components/TokenImage";
import { sol, StatsStrip, TradeCard, type TradeCoin, type TradeStats } from "../components/TradesDrawer";
import { useNow, usePolling } from "../hooks";
import { ago, shortAddress, usd } from "../format";
import { openTokenModal } from "../tokenModal";

/** The API reads the wallet's holdings from the chain at most every 5 minutes; the rest is our own rows. */
const PORTFOLIO_POLL_MS = 60_000;
const TRADES_POLL_MS = 30_000;
const FEES_POLL_MS = 60_000;

interface Holding {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  amount: number;
  priceUsd: number | null;
  valueUsd: number | null;
  marketCapUsd: number | null;
  pricedAt: string | null;
  firstAlert: { at: string; modelName: string | null } | null;
  card: Card | null;
}

interface Portfolio {
  holdings: {
    readAt: string;
    sol: number | null;
    solValueUsd: number | null;
    coins: Holding[];
    trackedCoins: number;
    trackedValueUsd: number;
    untracked: number;
    /** Tracked coins held below minSol (or unpriced): counted, not shown. */
    dust: number;
    minSol: number;
  } | null;
  botPositions: {
    id: string;
    mint: string;
    symbol: string | null;
    status: string;
    source: string;
    spentSol: number | null;
    gotSol: number;
    lastMultiple: number | null;
    highMultiple: number | null;
    lastPricedAt: string | null;
    openedAt: string | null;
  }[];
  tape: {
    coins: number;
    buys: number;
    sells: number;
    solIn: number;
    solOut: number;
    recent: {
      mint: string;
      symbol: string | null;
      name: string | null;
      imageUrl: string | null;
      buys: number;
      sells: number;
      solIn: number;
      solOut: number;
      firstBuyAt: string | null;
      readAt: string;
      creator: boolean;
      sniper: boolean;
    }[];
    risk: {
      score: number;
      appearances: number;
      wins: number;
      dumper: boolean;
      winner: boolean;
      sniper: boolean;
    } | null;
  };
  solUsd: number | null;
}

interface PortfolioTrades {
  open: TradeCoin[];
  closed: TradeCoin[];
  stats: TradeStats[];
  untracked: number;
  openTotal: number;
  closedTotal: number;
  days: number;
  solUsd: number | null;
}

/** GET /pro/trade/fees (apps/api/src/tradeFees.ts). */
interface FeesSaved {
  trades: number;
  buys: number;
  sells: number;
  volumeSol: number;
  platformFeeSol: number;
  networkFeeSol: number;
  /** The Sacrifice's mode and free cut-off (ASDF fee plan); absent from older APIs. */
  sacrifice?: { mode: "off" | "shadow" | "on"; freeRank: number };
  platforms: {
    id: string;
    name: string;
    buyBps: number;
    sellBps: number;
    feeSol: number;
    savedSol: number;
  }[];
  since: string | null;
  solUsd: number | null;
}

function amount(n: number): string {
  if (n >= 999_995_000) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 999_950) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 999.95) return `${(n / 1e3).toFixed(1)}K`;
  if (n === 0) return "0";
  return n >= 1 ? n.toFixed(0) : n.toPrecision(2);
}

const tone = (n: number | null | undefined) =>
  n === null || n === undefined || n === 0 ? "" : n > 0 ? " up" : " down";

/**
 * The Portfolio page (user ask 2026-10-18), opened from the wallet menu by Pro Mode wallets only: everything
 * TrenchScanner knows about the signed-in wallet's trading, for its owner alone (GET /portfolio and
 * GET /pro/trades?view=portfolio, both 404 for anyone else).
 * Figures cover the coins TrenchScanner tracks; the wallet's other coins are counted, not shown,
 * and each section says where its figures come from.
 */
export function PortfolioTab() {
  const { data, error } = usePolling<Portfolio>("/portfolio", PORTFOLIO_POLL_MS);
  const now = useNow(30_000);
  if (!data)
    return (
      <div className="stack portfolio">
        {error ? (
          <p className="error small" role="alert">
            Couldn&apos;t load your portfolio: {error.message}
          </p>
        ) : (
          <section className="panel">
            <Skeleton lines={4} />
          </section>
        )}
      </div>
    );
  return (
    <div className="stack portfolio">
      <p className="notice small portfolio-scope">
        <InfoIcon size={13} />
        <span>
          Your portfolio covers the coins TrenchScanner tracks. Coins in your wallet that we don&apos;t track
          are counted but not shown, unless a section says otherwise. Only you can see this page.
        </span>
      </p>
      <HoldingsPanel holdings={data.holdings} now={now} />
      <TradesPanel now={now} />
      <FeesPanel />
      {data.botPositions.length > 0 && <BotPanel positions={data.botPositions} now={now} />}
      <TapePanel tape={data.tape} now={now} />
    </div>
  );
}

function HoldingsPanel({ holdings, now }: { holdings: Portfolio["holdings"]; now: number }) {
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <WalletIcon size={13} /> Holdings
          </span>
          <h2>What your wallet holds</h2>
          <p className="muted small">
            Read from the chain every few minutes and priced from TrenchScanner&apos;s own scans. Tracked
            coins only.
          </p>
        </div>
        {holdings && (
          <span className="faint small" title={new Date(holdings.readAt).toLocaleString()}>
            Read {ago(holdings.readAt, now)}
          </span>
        )}
      </header>
      {!holdings ? (
        <p className="faint small">Your wallet couldn&apos;t be read just now. It is tried again shortly.</p>
      ) : (
        <>
          <dl className="facts portfolio-totals">
            <div>
              <dt>SOL</dt>
              <dd className="num">
                {holdings.sol === null ? "–" : sol(holdings.sol)}
                {holdings.solValueUsd !== null && (
                  <span className="faint small"> · {usd(holdings.solValueUsd)}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Tracked coins</dt>
              <dd className="num">
                {holdings.trackedCoins}
                <span className="faint small"> · {usd(holdings.trackedValueUsd)}</span>
              </dd>
            </div>
            <div>
              <dt>Not tracked</dt>
              <dd
                className="num"
                title="Coins in your wallet TrenchScanner doesn't track: counted, not shown"
              >
                {holdings.untracked} coin{holdings.untracked === 1 ? "" : "s"}
              </dd>
            </div>
          </dl>
          {holdings.coins.length === 0 ? (
            <p className="faint small portfolio-empty">
              Your wallet holds no coins TrenchScanner tracks worth {holdings.minSol} SOL or more.
            </p>
          ) : (
            <HoldingsGrid coins={holdings.coins} now={now} total={holdings.trackedCoins} />
          )}
          {holdings.dust > 0 && (
            <p className="faint small">
              {holdings.dust} more tracked coin{holdings.dust === 1 ? " is" : "s are"} worth under{" "}
              {holdings.minSol} SOL, so {holdings.dust === 1 ? "it isn't" : "they aren't"} shown.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The holdings cards that fit one row (two on narrow screens, where a row is one or two cards),
 * with Show all opening every listed coin in a dialog.
 */
function HoldingsGrid({ coins, now, total }: { coins: Holding[]; now: number; total: number }) {
  const grid = useRef<HTMLUListElement>(null);
  const [cols, setCols] = useState(0);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    // The grid's own auto-fill decides the columns; count the tracks it laid out.
    const measure = () => setCols(getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = cols === 0 ? coins.length : cols * (cols >= 3 ? 1 : 2);
  const shown = coins.slice(0, fit);
  return (
    <>
      <ul className="trades-grid portfolio-grid" ref={grid}>
        {shown.map((h) => (
          <li key={h.mint}>
            <HoldingCard holding={h} now={now} />
          </li>
        ))}
      </ul>
      {coins.length > shown.length && (
        <button type="button" className="ghost portfolio-more" onClick={() => setAll(true)}>
          Show all {coins.length}
        </button>
      )}
      <HoldingsDialog open={all} onClose={() => setAll(false)} coins={coins} now={now} total={total} />
    </>
  );
}

function HoldingsDialog({
  open,
  onClose,
  coins,
  now,
  total,
}: {
  open: boolean;
  onClose: () => void;
  coins: Holding[];
  now: number;
  total: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal holdings-modal"
      aria-labelledby="holdings-title"
      onClose={(e) => {
        // Only this dialog's own close: a nested dialog's close bubbles up through React.
        if (e.target === e.currentTarget) onClose();
      }}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="holdings-title">Your holdings · {coins.length}</h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        {open && (
          <>
            <ul className="trades-grid portfolio-grid">
              {coins.map((h) => (
                <li key={h.mint}>
                  <HoldingCard holding={h} now={now} />
                </li>
              ))}
            </ul>
            {total > coins.length && (
              <p className="faint small">
                Your {coins.length} largest of {total} tracked coins.
              </p>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}

function HoldingCard({ holding: h, now }: { holding: Holding; now: number }) {
  const label = h.symbol ? `$${h.symbol}` : shortAddress(h.mint);
  const card = h.card;
  return (
    <article
      className={`card compact trade-card${card ? " opens" : ""}`}
      onClick={() => card && openTokenModal(card, now)}
      {...(card && {
        role: "button",
        tabIndex: 0,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          openTokenModal(card, now);
        },
      })}
      title={card ? `${label}: open the chart, bubble map and details` : label}
    >
      <header className="card-head">
        <div className="avatar-wrap tone-neutral">
          <TokenImage
            url={h.imageUrl}
            size={72}
            width={34}
            height={34}
            className="avatar trade-avatar"
            fallback={
              <span className="avatar trade-avatar placeholder">{(h.symbol ?? "?").slice(0, 2)}</span>
            }
          />
        </div>
        <div className="card-title">
          <div className="title-row">
            <strong className="symbol" title={h.name ?? label}>
              {label}
            </strong>
          </div>
          <div className="meta-row">
            {h.firstAlert ? (
              <span
                className="pill"
                title={`First alert by ${h.firstAlert.modelName ?? "a model"}, ${new Date(h.firstAlert.at).toLocaleString()}`}
              >
                <span className="pill-text">Alerted {ago(h.firstAlert.at, now)}</span>
              </span>
            ) : (
              <span className="faint small">No model alert</span>
            )}
          </div>
        </div>
      </header>
      <div className="card-figures" style={{ "--fig-cols": 2 } as React.CSSProperties}>
        <div className="fig">
          <label>Value</label>
          <span className="num">{usd(h.valueUsd)}</span>
        </div>
        <div className="fig">
          <label>Mcap</label>
          <span className="num">{usd(h.marketCapUsd)}</span>
        </div>
      </div>
      <div className="trade-foot">
        <span className="faint num">{amount(h.amount)} held</span>
        {h.pricedAt && (
          <span className="faint" title={`Priced ${new Date(h.pricedAt).toLocaleString()}`}>
            {ago(h.pricedAt, now)}
          </span>
        )}
      </div>
    </article>
  );
}

/** Pro Mode only: the wallet's own buys and sells, as the TRADES panel follows them. */
function TradesPanel({ now }: { now: number }) {
  const { data, error } = usePolling<PortfolioTrades>("/pro/trades?view=portfolio", TRADES_POLL_MS);
  const [span, setSpan] = useState(0);
  const stats = data?.stats[span] ?? null;
  return (
    <section className="panel portfolio-trades">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <ChartIcon size={13} /> Positions
          </span>
          <h2>Your positions</h2>
          <p className="muted small">
            Every buy and sale this wallet makes, here or anywhere else. Each coin you buy is scanned on your
            buy, so these include coins TrenchScanner wouldn&apos;t otherwise track. The last{" "}
            {data?.days ?? 30} days.
          </p>
        </div>
        {data && (
          <div className="segmented small" role="group" aria-label="Statistics window">
            {data.stats.map((s, i) => (
              <button
                key={s.hours}
                type="button"
                className={i === span ? "on" : ""}
                aria-pressed={i === span}
                onClick={() => setSpan(i)}
              >
                {s.hours <= 24 ? "24h" : `${Math.round(s.hours / 24)}d`}
              </button>
            ))}
          </div>
        )}
      </header>
      {error && !data && (
        <p className="error small" role="alert">
          Couldn&apos;t load your positions: {error.message}
        </p>
      )}
      {!data ? (
        !error && <Skeleton lines={3} />
      ) : (
        <>
          {stats && (
            <div className="portfolio-stats">
              <StatsStrip stats={stats} solUsd={data.solUsd} />
            </div>
          )}
          <h3 className="portfolio-sub">
            Open <span className="faint">{data.openTotal}</span>
          </h3>
          {data.open.length === 0 ? (
            <p className="faint small portfolio-empty">No open positions.</p>
          ) : (
            <ul className="trades-grid portfolio-grid">
              {data.open.map((c) => (
                <li key={c.mint}>
                  <TradeCard coin={c} now={now} />
                </li>
              ))}
            </ul>
          )}
          <h3 className="portfolio-sub">
            Closed <span className="faint">{data.closedTotal}</span>
          </h3>
          {data.closed.length === 0 ? (
            <p className="faint small portfolio-empty">Nothing sold out of yet.</p>
          ) : (
            <ul className="trades-grid portfolio-grid">
              {data.closed.map((c) => (
                <li key={c.mint}>
                  <TradeCard coin={c} now={now} />
                </li>
              ))}
            </ul>
          )}
          {data.closedTotal > data.closed.length && (
            <p className="faint small">Showing the latest {data.closed.length} closed positions.</p>
          )}
          {data.untracked > 0 && (
            <p className="faint small">
              {data.untracked} more coin{data.untracked === 1 ? "" : "s"} traded had no market to scan, so{" "}
              {data.untracked === 1 ? "it isn't" : "they aren't"} shown.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Fees are small: four decimals below 1 SOL, where sol() would round most of them to 0. */
function feeSol(n: number): string {
  return n >= 1 ? sol(n) : `${n.toFixed(4)} SOL`;
}

const pct = (bps: number) => (bps === 0 ? "none" : `${bps / 100}%`);

/** Fees saved (user ask 2026-10-18): trades made here against other platforms' fees on the same trades. */
function FeesPanel() {
  const { data, error } = usePolling<FeesSaved>("/pro/trade/fees", FEES_POLL_MS);
  const best = data?.platforms.reduce((a, b) => (b.savedSol > a.savedSol ? b : a), data.platforms[0]!);
  const inUsd = (n: number) =>
    data?.solUsd ? <span className="faint small"> · {usd(n * data.solUsd)}</span> : null;
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <GiftIcon size={13} /> Fees saved
          </span>
          <h2>What trading here saved you</h2>
          <p className="muted small">
            Trades you made from TrenchScanner&apos;s Trade panel, against what the same trades would have
            paid in platform fees elsewhere.{" "}
            {data?.sacrifice?.mode === "on" ? (
              <>
                TrenchScanner&apos;s fee is 0% for the top {data.sacrifice.freeRank} $ASDFASDFA holders and a
                0.2% Sacrifice in burned credits on every trade for everyone else, counted here at its SOL
                value. A negative saving means the Sacrifice cost more than that platform&apos;s fee.
              </>
            ) : (
              <>TrenchScanner charges no platform fee.</>
            )}{" "}
            Every platform also pays the network (priority fee and tip), so that part isn&apos;t counted as
            saved.
            {data?.since && <> Counted since {new Date(data.since).toLocaleDateString()}.</>}
          </p>
        </div>
      </header>
      {error && !data && (
        <p className="error small" role="alert">
          Couldn&apos;t load your fees: {error.message}
        </p>
      )}
      {!data ? (
        !error && <Skeleton lines={3} />
      ) : data.trades === 0 ? (
        <p className="faint small portfolio-empty">
          No trades from the Trade panel yet. Once you buy or sell here, your savings show up.
        </p>
      ) : (
        <>
          <dl className="facts portfolio-totals">
            <div>
              <dt>Trades</dt>
              <dd className="num">
                {data.buys} buys / {data.sells} sales
              </dd>
            </div>
            <div>
              <dt>Volume</dt>
              <dd className="num">
                {sol(data.volumeSol)}
                {inUsd(data.volumeSol)}
              </dd>
            </div>
            <div>
              <dt>Fees paid here</dt>
              <dd className="num">
                {feeSol(data.platformFeeSol + data.networkFeeSol)}
                <span className="faint small"> · {feeSol(data.networkFeeSol)} network</span>
              </dd>
            </div>
            {best && (
              <div>
                <dt>Saved vs {best.name}</dt>
                <dd className={`num${tone(best.savedSol)}`}>
                  {feeSol(best.savedSol)}
                  {inUsd(best.savedSol)}
                </dd>
              </div>
            )}
          </dl>
          <div className="table-wrap">
            <table className="portfolio-table">
              <thead>
                <tr>
                  <th>Platform</th>
                  <th className="num">Buy fee</th>
                  <th className="num">Sell fee</th>
                  <th className="num">Their fees</th>
                  <th className="num">You saved</th>
                </tr>
              </thead>
              <tbody>
                {data.platforms.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="num">{pct(p.buyBps)}</td>
                    <td className="num">{pct(p.sellBps)}</td>
                    <td className="num">{feeSol(p.feeSol)}</td>
                    <td className={`num${tone(p.savedSol)}`}>
                      {feeSol(p.savedSol)}
                      {inUsd(p.savedSol)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function BotPanel({ positions, now }: { positions: Portfolio["botPositions"]; now: number }) {
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <RobotIcon size={13} /> Trading bot
          </span>
          <h2>Your bot&apos;s open positions</h2>
          <p className="muted small">Positions your trading bot holds now, priced by the bot.</p>
        </div>
      </header>
      <div className="table-wrap">
        <table className="portfolio-table">
          <thead>
            <tr>
              <th>Coin</th>
              <th>From</th>
              <th className="num">In</th>
              <th className="num">Back</th>
              <th className="num">Now</th>
              <th className="num">High</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.symbol ? `$${p.symbol}` : shortAddress(p.mint)}
                  {p.status !== "open" && <span className="faint small"> {p.status}</span>}
                </td>
                <td className="faint">{p.source}</td>
                <td className="num">{sol(p.spentSol)}</td>
                <td className="num">{sol(p.gotSol)}</td>
                <td className={`num${tone(p.lastMultiple === null ? null : p.lastMultiple - 1)}`}>
                  {p.lastMultiple === null ? "–" : `${p.lastMultiple.toFixed(2)}x`}
                </td>
                <td className="num">{p.highMultiple === null ? "–" : `${p.highMultiple.toFixed(2)}x`}</td>
                <td className="faint">{p.openedAt ? ago(p.openedAt, now) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TapePanel({ tape, now }: { tape: Portfolio["tape"]; now: number }) {
  const net = tape.solOut - tape.solIn;
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <TransferIcon size={13} /> Trade history
          </span>
          <h2>Your trades in tracked coins</h2>
          <p className="muted small">
            What this wallet did in the coins whose trades TrenchScanner recorded, wherever it traded. SOL in
            and out only: coins still held aren&apos;t valued here (Holdings has them).
          </p>
        </div>
      </header>
      <dl className="facts portfolio-totals">
        <div>
          <dt>Coins</dt>
          <dd className="num">{tape.coins}</dd>
        </div>
        <div>
          <dt>Buys / sales</dt>
          <dd className="num">
            {tape.buys} / {tape.sells}
          </dd>
        </div>
        <div>
          <dt>SOL in</dt>
          <dd className="num">{sol(tape.solIn)}</dd>
        </div>
        <div>
          <dt>SOL out</dt>
          <dd className="num">{sol(tape.solOut)}</dd>
        </div>
        <div>
          <dt>Net</dt>
          <dd className={`num${tone(net)}`}>{sol(net, true)}</dd>
        </div>
        <div>
          <dt>Wallet score</dt>
          <dd
            className="num"
            title="TrenchScanner's risk score for this wallet, 0-100 (higher is riskier), rebuilt hourly from its trades in tracked coins"
          >
            {tape.risk ? tape.risk.score.toFixed(0) : "–"}
            {tape.risk && (
              <span className="faint small">
                {" "}
                · {tape.risk.appearances} coins
                {tape.risk.winner ? " · winner" : ""}
                {tape.risk.sniper ? " · sniper" : ""}
              </span>
            )}
          </dd>
        </div>
      </dl>
      {tape.recent.length === 0 ? (
        <p className="faint small portfolio-empty">No trades recorded in tracked coins yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="portfolio-table">
            <thead>
              <tr>
                <th>Coin</th>
                <th className="num">Buys</th>
                <th className="num">Sales</th>
                <th className="num">In</th>
                <th className="num">Out</th>
                <th className="num">Net</th>
                <th>First buy</th>
              </tr>
            </thead>
            <tbody>
              {tape.recent.map((r) => (
                <tr key={r.mint}>
                  <td>
                    {r.symbol ? `$${r.symbol}` : shortAddress(r.mint)}
                    {r.creator && <span className="faint small"> creator</span>}
                    {r.sniper && <span className="faint small"> sniped</span>}
                  </td>
                  <td className="num">{r.buys}</td>
                  <td className="num">{r.sells}</td>
                  <td className="num">{sol(r.solIn)}</td>
                  <td className="num">{sol(r.solOut)}</td>
                  <td className={`num${tone(r.solOut - r.solIn)}`}>{sol(r.solOut - r.solIn, true)}</td>
                  <td className="faint">{r.firstBuyAt ? ago(r.firstBuyAt, now) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
