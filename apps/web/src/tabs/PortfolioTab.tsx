import { useState } from "react";
import { Skeleton } from "../components/Skeleton";
import { ChartIcon, GiftIcon, InfoIcon, RobotIcon, TransferIcon } from "../components/Icons";
import { sol, StatsStrip, TradeCard, type TradeCoin, type TradeStats } from "../components/TradesDrawer";
import { useNow, usePolling } from "../hooks";
import { ago, pricedAgeText, shortAddress, usd } from "../format";

const PORTFOLIO_POLL_MS = 60_000;
const TRADES_POLL_MS = 30_000;
const FEES_POLL_MS = 60_000;

interface Portfolio {
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
  /** When solUsd was read (ISO). Absent from older API builds. */
  solUsdAt?: string | null;
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
      <TradesPanel now={now} />
      <FeesPanel />
      {data.botPositions.length > 0 && <BotPanel positions={data.botPositions} now={now} />}
      <TapePanel tape={data.tape} now={now} />
    </div>
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
              <StatsStrip stats={stats} solUsd={data.solUsd} solUsdAt={data.solUsdAt} />
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
                  {p.status === "open" &&
                    p.lastPricedAt !== undefined &&
                    pricedAgeText(p.lastPricedAt, now) && (
                      <div className="faint small">{pricedAgeText(p.lastPricedAt, now)}</div>
                    )}
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
            and out only: coins still held aren&apos;t valued here (Positions has them).
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
