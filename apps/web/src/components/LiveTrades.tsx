import { useEffect, useMemo, useRef, useState } from "react";
import { usd } from "../format";
import { sinceText, solText, tallyTrades, useLiveTrades, type LiveTokenTrade } from "../liveTrades";
import { openWallet } from "../walletModal";
import { useWalletNames } from "../walletNames";
import { WalletText } from "./WalletText";
import { PulseIcon } from "./Icons";

type SideFilter = "all" | "buy" | "sell";

/** The summary line's window. */
const TALLY_MS = 5 * 60_000;
/** Wallet names are asked for this often at most, so a busy coin's new traders come in batches. */
const NAMES_EVERY_MS = 5_000;
/** Rows drawn at most: the newest. */
const SHOWN = 120;

/** The wallets to name, refreshed every NAMES_EVERY_MS rather than on each trade. */
function useBatchedWallets(trades: readonly LiveTokenTrade[]): string[] {
  const [wallets, setWallets] = useState<string[]>([]);
  const latest = useRef(trades);
  useEffect(() => {
    latest.current = trades;
  });
  const empty = trades.length === 0;
  useEffect(() => {
    if (empty) return;
    const read = () => {
      const next = [...new Set(latest.current.slice(-SHOWN).map((x) => x.wallet))].sort();
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

/**
 * The coin's trades as they land (user ask 2026-10-19): each buy and sell with its wallet, SOL and
 * the market cap it left, newest first, and the last five minutes' buys and sells above them. The
 * API follows the coin's trades on the chain stream only while this is open (liveTrades.ts).
 */
export function LiveTradesCard({ base }: { base: string }) {
  const feed = useLiveTrades(base, true);
  const [side, setSide] = useState<SideFilter>("all");
  const now = useNow();
  const names = useWalletNames(useBatchedWallets(feed.trades));
  const tally = useMemo(() => tallyTrades(feed.trades, now - TALLY_MS), [feed.trades, now]);
  const rows = useMemo(() => {
    const shown = side === "all" ? feed.trades : feed.trades.filter((t) => t.side === side);
    return shown.slice(-SHOWN).reverse();
  }, [feed.trades, side]);
  const net = tally.solIn - tally.solOut;

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
          {feed.status === "live" ? "Live" : feed.status === "unavailable" ? "Off" : "Connecting"}
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
      </h4>
      {feed.status === "unavailable" ? (
        <p className="muted small lt-empty">
          Live trades follow Pump.fun coins, on their bonding curve and after it on PumpSwap. This coin trades
          elsewhere, so there's nothing to follow here.
        </p>
      ) : (
        <>
          <dl className="lt-tally" title="The last five minutes of the trades read since this opened">
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
          {rows.length === 0 ? (
            <p className="muted small lt-empty">
              {feed.status === "live"
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
                  <span className="lt-sol num">{solText(t.sol)}</span>
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
