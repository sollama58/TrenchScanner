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
        // A cursor behind ours means the API restarted (or another instance answered) and its seqs
        // began again: it sent everything it has, so start over from that rather than dropping it
        // all as already seen, which froze the list until its seqs passed ours.
        const restarted = a.cursor < after.current;
        const fresh = restarted ? a.trades : a.trades.filter((t) => t.seq > after.current);
        after.current = restarted ? a.cursor : Math.max(after.current, a.cursor);
        setFeed((prev) => ({
          trades: restarted
            ? fresh.slice(-MAX_TRADES)
            : fresh.length > 0
              ? prev.trades.concat(fresh).slice(-MAX_TRADES)
              : prev.trades,
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

/**
 * What a trader can be, for the feed's wallet filter (user ask 2026-10-19). The labels that hold
 * everywhere come from the wallet's name and KOL ties, read for any trader; the coin's own come from
 * its scan (the top holders it read) and the chart's flagged wallets, so they cover those wallets.
 */
export type TradeLabel =
  | "kol"
  | "known"
  | "funded"
  | "probable"
  | "mine"
  | "exchange"
  | "username"
  | "dev"
  | "holder"
  | "sniper"
  | "fresh"
  | "empty"
  | "cluster"
  | "together"
  | "cexFunded"
  | "risky"
  | "winner";

export const TRADE_LABELS: readonly {
  id: TradeLabel;
  label: string;
  title: string;
  /** "all": a label the wallet carries on every coin; "coin": one read for this coin. */
  scope: "all" | "coin";
}[] = [
  { id: "kol", label: "KOLs", title: "Wallets on the KOL roster", scope: "all" },
  { id: "known", label: "Known Sides", title: "Other wallets we know are a KOL's own", scope: "all" },
  { id: "funded", label: "KOL Funded", title: "Wallets a KOL paid for (their first SOL)", scope: "all" },
  {
    id: "probable",
    label: "Probable Sides",
    title: "Wallets that keep buying a KOL's coins within minutes of it, or move coins with it",
    scope: "all",
  },
  {
    id: "mine",
    label: "Your labels",
    title: "Wallets you labeled (Settings > Labeled wallets)",
    scope: "all",
  },
  { id: "exchange", label: "Exchanges", title: "Exchange and launchpad wallets", scope: "all" },
  { id: "username", label: "Usernames", title: "Wallets with a Pump.fun or FOMO username", scope: "all" },
  { id: "dev", label: "Dev", title: "The coin's creator", scope: "coin" },
  { id: "holder", label: "Top holders", title: "Holders the coin's scan read", scope: "coin" },
  { id: "sniper", label: "Snipers", title: "Among the launch's first 25 buyers", scope: "coin" },
  { id: "fresh", label: "Fresh", title: "First active within 24 hours of the scan", scope: "coin" },
  { id: "empty", label: "Empty", title: "Under $25 in anything besides this coin", scope: "coin" },
  {
    id: "cluster",
    label: "Clusters",
    title: "Holders one funder paid for, and their funders",
    scope: "coin",
  },
  { id: "together", label: "Funded together", title: "Holders funded the same minute", scope: "coin" },
  { id: "cexFunded", label: "Exchange funded", title: "Holders an exchange paid for", scope: "coin" },
  { id: "risky", label: "Risky & dumpers", title: "High risk scores and known dumpers", scope: "coin" },
  { id: "winner", label: "Winners", title: "Wallets that often buy early into 2x coins", scope: "coin" },
];

/** The labels that need the KOL-side read (POST /wallets/possible-sides) for traders off the chart. */
export const SIDE_LABELS: ReadonlySet<TradeLabel> = new Set(["known", "funded", "probable"]);

/** The scan's holder reading, the parts the coin's labels read (api.ts Snapshot). */
export interface LabelSnapshot {
  linkedHolders?:
    | readonly ({
        wallet: string;
        cexFunder?: string;
        sniper?: boolean;
        fresh?: boolean;
        empty?: boolean;
      } | null)[]
    | null;
  linkedClusters?: readonly { funder: string; wallets: readonly { wallet: string }[] }[] | null;
  sameTimeClusters?: readonly { wallets: readonly { wallet: string }[] }[] | null;
}

/** A flagged wallet from the token chart (TokenModal's FlaggedWallet), the parts the labels read. */
export interface LabelFlagged {
  wallet: string;
  tags: readonly string[];
  knownSideOf?: string;
  side?: { kind: "funded" | "probable" };
}

/** Each wallet the coin's scan and chart label, with its labels. */
export function coinLabels(
  snapshot: LabelSnapshot | null | undefined,
  flagged: readonly LabelFlagged[],
): Map<string, Set<TradeLabel>> {
  const out = new Map<string, Set<TradeLabel>>();
  const add = (w: string | null | undefined, l: TradeLabel) => {
    if (!w) return;
    let s = out.get(w);
    if (!s) out.set(w, (s = new Set()));
    s.add(l);
  };
  for (const h of snapshot?.linkedHolders ?? []) {
    if (!h) continue;
    add(h.wallet, "holder");
    if (h.sniper) add(h.wallet, "sniper");
    if (h.fresh) add(h.wallet, "fresh");
    if (h.empty) add(h.wallet, "empty");
    if (h.cexFunder) add(h.wallet, "cexFunded");
  }
  for (const c of snapshot?.linkedClusters ?? []) {
    if (!c || !Array.isArray(c.wallets) || c.wallets.length === 0) continue;
    add(c.funder, "cluster");
    for (const w of c.wallets) add(w.wallet, "cluster");
  }
  for (const g of snapshot?.sameTimeClusters ?? [])
    for (const w of g?.wallets ?? []) add(w.wallet, "together");
  for (const f of flagged) {
    if (f.tags.includes("kol")) add(f.wallet, f.knownSideOf ? "known" : "kol");
    if (f.tags.includes("tracked")) add(f.wallet, "mine");
    if (f.side) add(f.wallet, f.side.kind);
    if (f.tags.includes("creator")) add(f.wallet, "dev");
    if (f.tags.includes("risky") || f.tags.includes("dumper")) add(f.wallet, "risky");
    if (f.tags.includes("winner")) add(f.wallet, "winner");
    if (f.tags.includes("linked")) add(f.wallet, "cluster");
  }
  return out;
}

/** A trader's labels: the coin's, plus those its name and KOL ties carry everywhere. */
export function traderLabels(
  wallet: string,
  coin: ReadonlyMap<string, ReadonlySet<TradeLabel>>,
  name: { source: string; service?: boolean; mine?: boolean } | undefined,
  sides: readonly { funded?: boolean; known?: boolean }[] | undefined,
): Set<TradeLabel> {
  const out = new Set<TradeLabel>(coin.get(wallet));
  if (name) {
    if (name.source === "kol") out.add("kol");
    if (name.source === "kol-side") out.add("known");
    if (name.source === "tracked" || name.mine) out.add("mine");
    if (name.source === "exchange" || name.service) out.add("exchange");
    if (name.source === "pumpfun" || name.source === "fomo") out.add("username");
  }
  for (const s of sides ?? []) out.add(s.known ? "known" : s.funded ? "funded" : "probable");
  return out;
}

/** The feed's filter: the trade's size in SOL and the kinds of wallet shown (any of them; none: all). */
export interface TradeFilter {
  minSol: number | null;
  maxSol: number | null;
  labels: readonly TradeLabel[];
}

export const NO_FILTER: TradeFilter = { minSol: null, maxSol: null, labels: [] };

/** How many parts of the filter are set, for its button. */
export function filterCount(f: TradeFilter): number {
  return (f.minSol !== null || f.maxSol !== null ? 1 : 0) + f.labels.length;
}

/** The trades that pass `f`: within its size, by a wallet with one of its labels. */
export function filterTrades(
  trades: readonly LiveTokenTrade[],
  f: TradeFilter,
  labelsOf: (wallet: string) => ReadonlySet<TradeLabel>,
): readonly LiveTokenTrade[] {
  if (filterCount(f) === 0) return trades;
  return trades.filter(
    (t) =>
      (f.minSol === null || t.sol >= f.minSol) &&
      (f.maxSol === null || t.sol <= f.maxSol) &&
      (f.labels.length === 0 || f.labels.some((l) => labelsOf(t.wallet).has(l))),
  );
}

const FILTER_KEY = "ts-live-trades-filter";
const LABEL_IDS = new Set<string>(TRADE_LABELS.map((l) => l.id));

/** A stored filter read back; anything unreadable is no filter. */
export function parseFilter(raw: string | null): TradeFilter {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<TradeFilter>) : null;
    if (!v || typeof v !== "object") return NO_FILTER;
    const sol = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
    const labels = Array.isArray(v.labels)
      ? [...new Set(v.labels.filter((l): l is TradeLabel => typeof l === "string" && LABEL_IDS.has(l)))]
      : [];
    return { minSol: sol(v.minSol), maxSol: sol(v.maxSol), labels };
  } catch {
    return NO_FILTER;
  }
}

/** The reader's filter, kept on this device so the feed opens the way they left it. */
export function useTradeFilter(): [TradeFilter, (f: TradeFilter) => void] {
  const [f, setF] = useState<TradeFilter>(() => {
    try {
      return parseFilter(window.localStorage.getItem(FILTER_KEY));
    } catch {
      return NO_FILTER;
    }
  });
  const set = (next: TradeFilter) => {
    setF(next);
    try {
      if (filterCount(next) === 0) window.localStorage.removeItem(FILTER_KEY);
      else window.localStorage.setItem(FILTER_KEY, JSON.stringify(next));
    } catch {
      // Storage off: the filter lasts while the view is open.
    }
  };
  return [f, set];
}
