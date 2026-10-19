import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/** Mirrors apps/api/src/liveTrades.ts LiveTokenTrade. */
export interface LiveTokenTrade {
  seq: number;
  sig: string;
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  tokens: number;
  atMs: number;
  /** USD market cap just after the trade, when known. */
  mcapUsd: number | null;
}

/** Mirrors apps/api/src/liveTrades.ts LiveTradesAnswer. */
export interface LiveTradesAnswer {
  status: "live" | "pending" | "unavailable";
  since: number | null;
  cursor: number;
  trades: LiveTokenTrade[];
  held?: boolean;
}

export interface LiveTrades {
  /** Every trade read so far, oldest first, the newest MAX_TRADES. */
  trades: LiveTokenTrade[];
  /** null before the first answer. */
  status: LiveTradesAnswer["status"] | null;
  /** From when the feed holds every trade (ms); null until it is live. */
  since: number | null;
}

/** What the view keeps: the API's own window. */
export const MAX_TRADES = 200;
/** How often to ask again from an API that answered at once (pending, or an older build). */
const POLL_MS = 2_000;
/** A held ask comes back with a trade; the next goes out no sooner than this after the last. */
const HELD_GAP_MS = 750;
const MAX_BACKOFF_MS = 30_000;

/**
 * A coin's live trades (user ask 2026-10-19): while `enabled`, asks `base`/trades/live for the
 * trades since the last answer, the API holding each ask until the next one lands. The API
 * follows the coin's trades on the chain stream only while someone asks, so nothing is read for a
 * closed view. Only while the tab is visible; a failure backs off and keeps trying.
 */
export function useLiveTrades(base: string, enabled: boolean): LiveTrades {
  const [feed, setFeed] = useState<LiveTrades>({ trades: [], status: null, since: null });
  const after = useRef(0);

  useEffect(() => {
    setFeed({ trades: [], status: null, since: null });
    after.current = 0;
    if (!enabled) return;
    let stopped = false;
    let timer: number | undefined;
    let failures = 0;
    const abort = new AbortController();
    const next = (ms: number) => {
      window.clearTimeout(timer);
      if (!stopped) timer = window.setTimeout(() => void poll(), ms);
    };
    const poll = async () => {
      if (document.visibilityState !== "visible") return next(POLL_MS);
      const sent = Date.now();
      try {
        const a = await api<LiveTradesAnswer>(`${base}/trades/live?after=${after.current}&wait=1`, {
          signal: abort.signal,
        });
        if (stopped) return;
        failures = 0;
        const fresh = a.trades.filter((t) => t.seq > after.current);
        after.current = Math.max(after.current, a.cursor);
        setFeed((prev) => ({
          trades: fresh.length > 0 ? prev.trades.concat(fresh).slice(-MAX_TRADES) : prev.trades,
          status: a.status,
          since: a.since,
        }));
        if (a.status !== "unavailable")
          next(a.held ? Math.max(0, HELD_GAP_MS - (Date.now() - sent)) : POLL_MS);
      } catch {
        if (!stopped) next(Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** ++failures));
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [base, enabled]);

  return feed;
}

export interface TradeTally {
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  /** Wallets that traded, each once. */
  traders: number;
}

/** The buys and sells since `fromMs`, for the feed's summary line. */
export function tallyTrades(trades: readonly LiveTokenTrade[], fromMs: number): TradeTally {
  const out: TradeTally = { buys: 0, sells: 0, solIn: 0, solOut: 0, traders: 0 };
  const wallets = new Set<string>();
  for (const t of trades) {
    if (t.atMs < fromMs) continue;
    wallets.add(t.wallet);
    if (t.side === "buy") {
      out.buys += 1;
      out.solIn += t.sol;
    } else {
      out.sells += 1;
      out.solOut += t.sol;
    }
  }
  out.traders = wallets.size;
  return out;
}

/** A trade's SOL as the feed shows it: two decimals, three under 0.1, "<0.001" for dust. */
export function solText(sol: number): string {
  if (sol > 0 && sol < 0.001) return "<0.001";
  return sol >= 100 ? sol.toFixed(0) : sol >= 0.1 ? sol.toFixed(2) : sol.toFixed(3);
}

/** How long ago a trade landed, short: "now", "12s", "4m", "2h". */
export function sinceText(atMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - atMs) / 1000));
  if (s < 2) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}
