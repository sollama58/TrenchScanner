import { useState, type KeyboardEvent } from "react";
import type { Card } from "../api";
import { Skeleton } from "../components/Charts";
import {
  BellIcon,
  ChartIcon,
  CopyIcon,
  CheckIcon,
  InfoIcon,
  RobotIcon,
  ShieldIcon,
  TransferIcon,
  WalletIcon,
} from "../components/Icons";
import { TokenImage } from "../components/TokenImage";
import { sol, StatsStrip, TradeCard, type TradeCoin, type TradeStats } from "../components/TradesDrawer";
import { useNow, usePolling } from "../hooks";
import { ago, multiple, shortAddress, usd } from "../format";
import { openTokenModal } from "../tokenModal";
import type { Tab } from "../routes";

/** The API reads the wallet's holdings from the chain at most every 5 minutes; the rest is our own rows. */
const PORTFOLIO_POLL_MS = 60_000;
const TRADES_POLL_MS = 30_000;

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
  account: {
    walletAddress: string;
    memberSince: string;
    admin: boolean;
    access: {
      hasAccess: boolean;
      reason: "admin" | "whitelist" | "subscription" | "free_access" | "none";
      expiresAt: string | null;
    };
    pro: { source: string | null; rank: number | null; graceEndsAt: string | null };
    burnCredits: number;
    lookups30d: number;
    burns: { count: number; months: number };
    telegramChats: number;
    linkedDevices: number;
  };
  holdings: {
    readAt: string;
    sol: number | null;
    solValueUsd: number | null;
    coins: Holding[];
    trackedCoins: number;
    trackedValueUsd: number;
    untracked: number;
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
  alerts: {
    last7d: number;
    last30d: number;
    doubled30d: number;
    best30d: {
      at: string;
      peakReturnPct: number | null;
      mint: string;
      symbol: string | null;
      imageUrl: string | null;
    } | null;
    filtersActive: number;
    filtersOff: number;
    modelAlertsOn: boolean;
    followsBestModel: boolean;
    followedModels: { id: string; name: string }[] | null;
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

const ACCESS_TEXT: Record<Portfolio["account"]["access"]["reason"], string> = {
  admin: "Admin",
  whitelist: "Whitelisted",
  subscription: "Subscriber",
  free_access: "Free access",
  none: "No access",
};

function date(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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
 * The Portfolio tab (user ask 2026-10-18), shown to Pro Mode wallets only: everything
 * TrenchScanner knows about the signed-in wallet, for its owner alone (GET /portfolio and
 * GET /pro/trades?view=portfolio, both 404 for anyone else).
 * Figures cover the coins TrenchScanner tracks; the wallet's other coins are counted, not shown,
 * and each section says where its figures come from.
 */
export function PortfolioTab({ goTo }: { goTo: (tab: Tab) => void }) {
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
      <AccountPanel account={data.account} goTo={goTo} />
      <HoldingsPanel holdings={data.holdings} now={now} />
      <TradesPanel now={now} />
      {data.botPositions.length > 0 && <BotPanel positions={data.botPositions} now={now} />}
      <TapePanel tape={data.tape} now={now} />
      <AlertsPanel alerts={data.alerts} goTo={goTo} />
    </div>
  );
}

function AccountPanel({ account, goTo }: { account: Portfolio["account"]; goTo: (tab: Tab) => void }) {
  const [copied, setCopied] = useState(false);
  const { access } = account;
  const copy = () =>
    void navigator.clipboard
      .writeText(account.walletAddress)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <ShieldIcon size={13} /> Account
          </span>
          <h2>Your account</h2>
        </div>
        <button type="button" className="ghost" onClick={() => goTo("settings")}>
          Account settings
        </button>
      </header>
      <dl className="facts">
        <div>
          <dt>Wallet</dt>
          <dd className="num portfolio-wallet">
            <span title="Your wallet. Only you see it here.">{shortAddress(account.walletAddress)}</span>
            <button
              type="button"
              className="ghost icon-btn"
              onClick={copy}
              aria-label={copied ? "Copied" : "Copy your wallet address"}
            >
              {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            </button>
          </dd>
        </div>
        <div>
          <dt>Signed up</dt>
          <dd className="num">{date(account.memberSince)}</dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>
            <span className={`badge ${access.hasAccess ? "good" : "bad"}`}>{ACCESS_TEXT[access.reason]}</span>
            {access.expiresAt && (
              <span className="faint small">
                {" "}
                {access.hasAccess ? "until" : "ended"} {date(access.expiresAt)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Pro Mode</dt>
          <dd>
            {account.pro.source === "holder" || account.pro.source === "grace"
              ? `Top holder${account.pro.rank ? ` #${account.pro.rank}` : ""}`
              : account.pro.source === "grant"
                ? "Granted"
                : "On"}
            {account.pro.graceEndsAt && (
              <span className="faint small"> until {new Date(account.pro.graceEndsAt).toLocaleString()}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Burn Credits</dt>
          <dd className="num">
            {account.burnCredits}
            <span className="faint small"> · {account.lookups30d} lookups in 30 days</span>
          </dd>
        </div>
        <div>
          <dt>Subscription burns</dt>
          <dd className="num">
            {account.burns.count}
            {account.burns.months > 0 && (
              <span className="faint small">
                {" "}
                · {account.burns.months} month{account.burns.months === 1 ? "" : "s"} bought
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Telegram chats</dt>
          <dd className="num">{account.telegramChats}</dd>
        </div>
        <div>
          <dt>Linked phones</dt>
          <dd className="num">{account.linkedDevices}</dd>
        </div>
      </dl>
    </section>
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
            <p className="faint small portfolio-empty">Your wallet holds no coins TrenchScanner tracks.</p>
          ) : (
            <ul className="trades-grid portfolio-grid">
              {holdings.coins.map((h) => (
                <li key={h.mint}>
                  <HoldingCard holding={h} now={now} />
                </li>
              ))}
            </ul>
          )}
          {holdings.trackedCoins > holdings.coins.length && (
            <p className="faint small">
              Showing your {holdings.coins.length} largest of {holdings.trackedCoins} tracked coins.
            </p>
          )}
        </>
      )}
    </section>
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

function AlertsPanel({ alerts, goTo }: { alerts: Portfolio["alerts"]; goTo: (tab: Tab) => void }) {
  const doubledPct = alerts.last30d > 0 ? Math.round((alerts.doubled30d / alerts.last30d) * 100) : null;
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <BellIcon size={13} /> Alerts
          </span>
          <h2>Your alerts</h2>
          <p className="muted small">Alerts from your own filters, and the models your feed follows.</p>
        </div>
        <button type="button" className="ghost" onClick={() => goTo("filters")}>
          Filters
        </button>
      </header>
      <dl className="facts">
        <div>
          <dt>Filters</dt>
          <dd className="num">
            {alerts.filtersActive} on
            {alerts.filtersOff > 0 && <span className="faint small"> · {alerts.filtersOff} off</span>}
          </dd>
        </div>
        <div>
          <dt>Filter alerts</dt>
          <dd className="num">
            {alerts.last7d}
            <span className="faint small"> in 7 days · {alerts.last30d} in 30</span>
          </dd>
        </div>
        <div>
          <dt>Reached 2x</dt>
          <dd
            className="num"
            title="Of your filter alerts in the last 30 days, how many went on to double from the alert"
          >
            {alerts.doubled30d}
            {doubledPct !== null && <span className="faint small"> · {doubledPct}% of 30 days</span>}
          </dd>
        </div>
        <div>
          <dt>Best in 30 days</dt>
          <dd className="num">
            {alerts.best30d ? (
              <>
                {alerts.best30d.symbol ? `$${alerts.best30d.symbol}` : shortAddress(alerts.best30d.mint)}{" "}
                <span className="up">{multiple(alerts.best30d.peakReturnPct)}</span>
              </>
            ) : (
              "–"
            )}
          </dd>
        </div>
        <div>
          <dt>Model alerts</dt>
          <dd>
            {!alerts.modelAlertsOn
              ? "Off"
              : alerts.followsBestModel
                ? "Best performer"
                : (alerts.followedModels ?? []).map((m) => m.name).join(", ") || "Default"}
            <button type="button" className="link small portfolio-link" onClick={() => goTo("model")}>
              Models
            </button>
          </dd>
        </div>
      </dl>
    </section>
  );
}
