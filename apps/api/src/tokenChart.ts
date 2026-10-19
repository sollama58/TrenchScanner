import { createLogger, fetchJson, HttpError, PUMP_SUPPLY_TOKENS, pumpFunSwapGate } from "@trenchscanner/core";

const logger = createLogger("token-chart");

/** One minute of a coin's trading, priced as market cap (USD price x Pump.fun's one billion supply; onSupply puts it on the supply now). */
export interface McapCandle {
  /** The minute's start, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** The minute's traded volume in USD (0 when Pump.fun sent none). */
  vol: number;
}

/** Minutes per answer of Pump.fun's candle API: its most recent minutes with a trade. */
const CANDLE_PAGE = 1000;

/**
 * Exported for tests. Pump.fun's one-minute USD candles as market-cap candles, oldest first;
 * candles with a missing or non-positive price are dropped. Prices arrive as decimal strings.
 */
export function parseMcapCandles(body: unknown, supply = PUMP_SUPPLY_TOKENS): McapCandle[] {
  if (!Array.isArray(body)) return [];
  const num = (v: unknown) => (typeof v === "string" || typeof v === "number" ? Number(v) : Number.NaN);
  const out: McapCandle[] = [];
  for (const raw of body as Record<string, unknown>[]) {
    const t = typeof raw?.timestamp === "number" ? raw.timestamp : Number.NaN;
    const o = num(raw?.open);
    const h = num(raw?.high);
    const l = num(raw?.low);
    const c = num(raw?.close);
    const vol = num(raw?.volume);
    if (![t, o, h, l, c].every(Number.isFinite) || Math.min(o, h, l, c) <= 0) continue;
    out.push({
      t,
      o: o * supply,
      // A malformed candle whose high/low don't bracket its open and close still draws sensibly.
      h: Math.max(h, o, c) * supply,
      l: Math.min(l, o, c) * supply,
      c: c * supply,
      vol: Number.isFinite(vol) && vol > 0 ? vol : 0,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Exported for tests. Candles on the launch billion put on the coin's supply now (`factor`: supply
 * over 1B, mintSupply.ts), so the chart reads the market cap the top bar and the cards do once
 * burns have taken some of the billion out. Volume is in USD and stays as it is.
 */
export function onSupply(candles: McapCandle[], factor: number | undefined): McapCandle[] {
  if (factor === undefined || factor === 1 || !(factor > 0)) return candles;
  return candles.map((k) => ({ ...k, o: k.o * factor, h: k.h * factor, l: k.l * factor, c: k.c * factor }));
}

/**
 * Exported for tests. Only candles a chart can draw: a finite time, finite positive o/h/l/c and a
 * finite volume (0 otherwise). One NaN from any source made the chart's axis NaN and drew nothing,
 * with no error (charts audit item 18), so every answer goes through this on its way out.
 */
export function drawableCandles(candles: readonly McapCandle[]): McapCandle[] {
  const out: McapCandle[] = [];
  for (const k of candles) {
    if (![k.t, k.o, k.h, k.l, k.c].every(Number.isFinite) || Math.min(k.o, k.h, k.l, k.c) <= 0) continue;
    out.push(Number.isFinite(k.vol) && k.vol >= 0 ? k : { ...k, vol: 0 });
  }
  return out;
}

export type CandleFetcher = (mint: string) => Promise<McapCandle[] | null>;

/** Candle widths the first-minutes chart reads (Pump.fun also serves 30s and up). */
export type CandleInterval = "1s" | "15s" | "1m";

/**
 * Reads a coin's candles from Pump.fun's swap API: its most recent CANDLE_PAGE candles of
 * `interval` with a trade. Null when Pump.fun has no such coin.
 */
export function pumpFunCandleFetcher(
  baseUrl = "https://swap-api.pump.fun",
  interval: CandleInterval = "1m",
): CandleFetcher {
  return async (mint) => {
    try {
      const body = await fetchJson<unknown>(
        `${baseUrl}/v1/coins/${encodeURIComponent(mint)}/candles?interval=${interval}&limit=${CANDLE_PAGE}&currency=USD`,
        // The process's swap-api budget, shared by every chart cache: a 429 pauses them all.
        { timeoutMs: 6_000, retries: 0, gate: pumpFunSwapGate },
      );
      return parseMcapCandles(body);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  };
}

/**
 * Pump.fun calls allowed per rolling minute, shared by several caches (user ask 2026-10-19, "fix
 * all"): the four chart caches each had a budget of their own and together could ask for more than
 * the swap-api gate lets through (pumpfunGate.ts), so the overflow failed at the gate instead.
 */
export class CallBudget {
  private readonly calls: number[] = [];

  constructor(
    readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the minute has room for one more call. */
  hasRoom(): boolean {
    const now = this.now();
    while (this.calls.length > 0 && this.calls[0]! <= now - 60_000) this.calls.shift();
    return this.calls.length < this.perMinute;
  }

  /** Counts one call. */
  spend(): void {
    this.calls.push(this.now());
  }
}

export interface CandleCacheOptions {
  /** How long one coin's answer is reused: every reader of a coin within it shares one call. */
  ttlMs?: number;
  /** Pump.fun calls allowed per rolling minute for this cache alone. */
  callsPerMinute?: number;
  /** A budget shared with the other chart caches, checked as well as this cache's own. */
  shared?: CallBudget;
  /** Coins kept; the least recently read one goes first. */
  maxEntries?: number;
  /**
   * How long a reader of an expired answer waits on its refresh before taking the last good answer
   * (marked stale) instead, so a slow Pump.fun never holds a chart for its whole timeout.
   */
  refreshWaitMs?: number;
  /** A last good answer older than this is no longer served: no candles beats very old ones. */
  maxStaleMs?: number;
  now?: () => number;
}

/** A coin's candles from the cache, and whether they are past their TTL (a refresh failed or is pending). */
export interface CandleRead {
  candles: McapCandle[] | null;
  stale: boolean;
}

/** After a failed refresh the next waits this long, so a down Pump.fun isn't asked by every reader. */
const FAILED_RETRY_MS = 5_000;

interface CandleEntry {
  /** The last good answer (null: Pump.fun has no such coin) and when it was read; unset before one. */
  good?: { value: McapCandle[] | null; at: number };
  expiresAt: number;
  /** No refresh before this: a failure's backoff. */
  retryAt: number;
  refreshing: Promise<void> | null;
}

/**
 * The token modal's candles, per coin, single-flight and on a call budget: the first reader of a
 * coin starts the one Pump.fun call and everyone else in the TTL shares it, so a burst of readers
 * never turns into a burst of upstream calls.
 *
 * Stale-while-revalidate (user ask 2026-10-19, "fix all"; charts audit items 1 and 2): once an
 * answer expires the next reader starts its refresh, but a failed, timed-out or over-budget refresh
 * never takes the last good answer away. Readers keep getting it, marked stale, until a refresh
 * lands. One Pump.fun 429 used to blank every open chart for the gate's 30 s pause. Only a coin
 * never read gets null, and the routes fill that from the stream (streamCandles.ts).
 */
export class CandleCache {
  private readonly entries = new Map<string, CandleEntry>();
  private readonly budget: CallBudget;
  private readonly shared: CallBudget | undefined;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly refreshWaitMs: number;
  private readonly maxStaleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly fetcher: CandleFetcher,
    opts: CandleCacheOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.budget = new CallBudget(opts.callsPerMinute ?? 60, this.now);
    this.shared = opts.shared;
    this.maxEntries = opts.maxEntries ?? 300;
    this.refreshWaitMs = opts.refreshWaitMs ?? 2_000;
    this.maxStaleMs = opts.maxStaleMs ?? 15 * 60_000;
  }

  /** The coin's candles (see read): null when there are none to give. */
  async get(mint: string): Promise<McapCandle[] | null> {
    return (await this.read(mint)).candles;
  }

  /**
   * The coin's candles and whether they are stale. A fresh answer is served as it is. An expired one
   * starts a refresh (within budget) and waits up to refreshWaitMs for it, then serves the last good
   * answer marked stale if the refresh hasn't landed. A coin with no answer yet waits for its first.
   */
  async read(mint: string): Promise<CandleRead> {
    const now = this.now();
    let entry = this.entries.get(mint);
    if (entry) {
      // Re-inserted so the Map's order stays least-recently-read first.
      this.entries.delete(mint);
      this.entries.set(mint, entry);
      if (entry.good && entry.expiresAt > now) return { candles: entry.good.value, stale: false };
    } else {
      entry = { expiresAt: 0, retryAt: 0, refreshing: null };
      this.entries.set(mint, entry);
      this.evict();
    }
    const refresh = this.refresh(mint, entry, now);
    if (refresh) await (entry.good ? within(refresh, this.refreshWaitMs) : refresh);
    return this.served(entry);
  }

  /** The coin's last good candles without asking Pump.fun: for a reader that mustn't spend the budget. */
  peek(mint: string): CandleRead {
    const entry = this.entries.get(mint);
    return entry ? this.served(entry) : { candles: null, stale: false };
  }

  private served(entry: CandleEntry): CandleRead {
    const good = entry.good;
    if (!good) return { candles: null, stale: false };
    const now = this.now();
    if (entry.expiresAt > now) return { candles: good.value, stale: false };
    if (now - good.at > this.maxStaleMs) return { candles: null, stale: false };
    return { candles: good.value, stale: good.value !== null };
  }

  /** Starts (or joins) the coin's refresh; null when none runs (over budget, or backing off a failure). */
  private refresh(mint: string, entry: CandleEntry, now: number): Promise<void> | null {
    if (entry.refreshing) return entry.refreshing;
    if (now < entry.retryAt) return null;
    if (!this.budget.hasRoom() || (this.shared && !this.shared.hasRoom())) return null;
    this.budget.spend();
    this.shared?.spend();
    const run = this.fetcher(mint)
      .then((value) => {
        const at = this.now();
        // Nothing back for a coin that had candles is a glitch upstream, not news: the candles
        // stay, and it is asked again after the backoff.
        if ((value === null || value.length === 0) && entry.good?.value?.length) {
          entry.retryAt = at + FAILED_RETRY_MS;
          return;
        }
        entry.good = { value, at };
        entry.expiresAt = at + this.ttlMs;
      })
      .catch((err: unknown) => {
        logger.warn("candles failed", { mint, error: String(err) });
        // Remembered only briefly, so a reader soon tries again; the last good answer stays.
        entry.retryAt = this.now() + FAILED_RETRY_MS;
      })
      .finally(() => {
        entry.refreshing = null;
      });
    entry.refreshing = run;
    return run;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** Resolves when `p` settles or after `ms`, whichever is first. */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void p.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** How much of a coin's start the first-minutes chart covers. */
export const FIRST_MINUTES_MS = 15 * 60_000;
/** The first candle may come this long after the launch time and still count as its start. */
const FIRST_CANDLE_SLACK_MS = 2 * 60_000;

/**
 * Exported for tests. The candles of a coin's first FIRST_MINUTES_MS from `startAt` (its launch,
 * else the first candle), or null when the page doesn't reach back to the start: Pump.fun answers
 * with the most recent candles, so on a busy coin the start has scrolled out of reach.
 */
export function firstMinutes(candles: readonly McapCandle[], startAt: number | null): McapCandle[] | null {
  if (candles.length === 0) return null;
  const start = startAt ?? candles[0]!.t;
  if (candles[0]!.t > start + FIRST_CANDLE_SLACK_MS) return null;
  const out = candles.filter((k) => k.t < start + FIRST_MINUTES_MS);
  return out.length > 0 ? out : null;
}

/** Why a wallet's trades are marked on the chart. */
export type WalletTag = "risky" | "dumper" | "linked" | "creator" | "kol" | "winner" | "side" | "tracked";

/** A KOL side label short of a Known Side (possibleSides.ts): a wallet a KOL funded, or a Probable Side. */
export interface SideLabel {
  kind: "funded" | "probable";
  /** The KOL's main wallet, and its roster name (null when it has none). */
  kolWallet: string;
  kolName: string | null;
  /** A tie to a wallet the reader labeled (withTrackedMarks): its kind. Absent on the roster's. */
  tracked?: "kol" | "tracked";
}

/** One marked trade: [time in ms, 1 buy / -1 sell, SOL (null when only the time is known)]. */
export type MarkedTrade = [atMs: number, side: 1 | -1, sol: number | null];

/** A wallet whose trades the token modal marks, with what it did in the coin. */
export interface MarkedWallet {
  wallet: string;
  tags: WalletTag[];
  /** Its risk score (WalletRisk), when it has one: wallets seen in fewer than two coins don't. */
  score: number | null;
  /** Coins it sold into a stop, of the coins it bought. */
  dumps: number | null;
  coins: number | null;
  /** The linked cluster's funder, when it is in one. */
  funder: string | null;
  /** On Solana Tracker's KOL roster (KolWallet): its name, or "" when the roster has none. On a
   *  Known Side, the name of the KOL it is a side of. */
  kol?: string | null;
  /** A KOL's Known Side (KolWallet.mainWallet): the KOL's main wallet. Tagged "kol", named as a side. */
  knownSideOf?: string;
  /** Tagged "side": the KOL side label it carries (a funded wallet or a Probable Side). */
  side?: SideLabel;
  /** Tagged "tracked": the name the reader gave it as a User Tracked wallet (withTrackedMarks). */
  tracked?: string;
  solIn: number;
  solOut: number;
  /** % of supply it held at the call. */
  heldPct: number | null;
  /** Its trades in the coin, oldest first. Only first buy and first sell on rows read before the
   *  tape kept every trade. */
  trades: MarkedTrade[];
}

/** The parts of a TokenWalletActivity row the markers need. */
export interface ActivityRow {
  wallet: string;
  isCreator: boolean;
  solIn: number;
  solOut: number;
  heldPctAtAnchor: number | null;
  firstBuyAt: Date | null;
  firstSellAt: Date | null;
  trades: unknown;
}

/** A WalletRisk row as the markers read it: its score and the labels the rebuild decided. */
export interface RiskRow {
  score: number;
  dumps: number;
  appearances: number;
  /** The count-and-rate labels (walletLabels in core); absent reads as neither. */
  dumper?: boolean;
  winner?: boolean;
}
export interface MarkOpts {
  riskyScore: number;
}

/** Wallets the chart marks at most, riskiest first, and their trades at most in all. */
export const MAX_MARKED_WALLETS = 40;
export const MAX_MARKED_TRADES = 2_000;

/**
 * Exported for tests. The wallets in a coin's trade tape worth marking on its chart: a risk score
 * of RISKY_WALLET_SCORE or more, a known dumper or a winner (the labels the wallet book carries,
 * walletLabels in core), a member of one of the coin's linked clusters, the coin's creator, or a
 * known KOL (`kols`: wallet to name; `knownSides`: a Known Side to its KOL's main wallet), or a KOL's
 * funded wallet or Probable Side (`sides`). Riskiest first (creator, KOL and linked wallets ahead of
 * unscored ones), capped at MAX_MARKED_WALLETS and MAX_MARKED_TRADES.
 */
export function markedWallets(
  rows: readonly ActivityRow[],
  risk: ReadonlyMap<string, RiskRow>,
  clusters: readonly { funder: string; wallets: readonly { wallet: string }[] }[],
  opts: MarkOpts,
  kols: ReadonlyMap<string, string | null> = new Map(),
  knownSides: ReadonlyMap<string, string> = new Map(),
  sides: ReadonlyMap<string, SideLabel> = new Map(),
): MarkedWallet[] {
  const funderOf = new Map<string, string>();
  for (const c of clusters) for (const w of c.wallets) funderOf.set(w.wallet, c.funder);
  const out: MarkedWallet[] = [];
  for (const r of rows) {
    const k = risk.get(r.wallet);
    const funder = funderOf.get(r.wallet) ?? null;
    const tags: WalletTag[] = [];
    if (r.isCreator) tags.push("creator");
    if (k && k.score >= opts.riskyScore) tags.push("risky");
    if (k?.dumper) tags.push("dumper");
    if (k?.winner) tags.push("winner");
    if (funder) tags.push("linked");
    const kol = kols.has(r.wallet) ? (kols.get(r.wallet) ?? "") : null;
    if (kol !== null) tags.push("kol");
    // A KOL (or Known Side) is already named as one; a side label only adds to other wallets.
    const side = kol === null ? sides.get(r.wallet) : undefined;
    if (side) tags.push("side");
    if (tags.length === 0) continue;
    const trades = storedTrades(r.trades) ?? firstTrades(r);
    if (trades.length === 0) continue;
    out.push({
      wallet: r.wallet,
      tags,
      score: k?.score ?? null,
      dumps: k?.dumps ?? null,
      coins: k?.appearances ?? null,
      funder,
      kol,
      ...(kol !== null && knownSides.has(r.wallet) ? { knownSideOf: knownSides.get(r.wallet) } : {}),
      ...(side ? { side } : {}),
      solIn: r.solIn,
      solOut: r.solOut,
      heldPct: r.heldPctAtAnchor,
      trades,
    });
  }
  return rankAndCap(out);
}

/**
 * Wallets withTrackedMarks adds past the shared list at most, per coin: the reader's labeled wallets
 * and their sides that traded it. Labels go to 250 a reader, but few of them trade any one coin.
 */
export const MAX_TRACKED_MARKED_WALLETS = 40;

/**
 * The shared marked wallets (the cached markedWallets answer, never changed in place) with the
 * reader's labels laid over them (user ask 2026-10-18, apps/api/src/trackedWallets.ts): a wallet
 * they labeled KOL is a KOL by their name, one labeled User Tracked is tagged "tracked", and a
 * wallet one of them funded or that is its Probable Side (`sides`, as loadTrackedSides answers)
 * carries that side label when it has no KOL tie of its own. `rows`: the coin's trade-tape rows of
 * those wallets (trackedActivity). Wallets the shared list left out are added after it, within
 * MAX_TRACKED_MARKED_WALLETS and what is left of MAX_MARKED_TRADES.
 */
export function withTrackedMarks(
  wallets: readonly MarkedWallet[],
  rows: readonly ActivityRow[],
  tracked: readonly { wallet: string; name: string; category: "kol" | "tracked" }[],
  sides: Readonly<
    Record<
      string,
      readonly { kolWallet: string; kolName: string | null; funded?: boolean; tracked?: "kol" | "tracked" }[]
    >
  >,
): MarkedWallet[] {
  const out = [...wallets];
  if (tracked.length === 0 || rows.length === 0) return out;
  const label = new Map(tracked.map((t) => [t.wallet, t]));
  const at = new Map(out.map((w, i) => [w.wallet, i]));
  let budget = MAX_MARKED_TRADES - out.reduce((n, w) => n + w.trades.length, 0);
  let added = 0;
  for (const r of rows) {
    const t = label.get(r.wallet);
    const s = t ? undefined : sides[r.wallet]?.find((e) => e.tracked);
    if (!t && !s) continue;
    const patch = (w: MarkedWallet): MarkedWallet => {
      const tags = new Set(w.tags);
      if (t?.category === "kol") {
        // Named as the reader's KOL: not a Known Side or someone else's side for them.
        tags.add("kol");
        tags.delete("side");
        const { knownSideOf: _k, side: _s, ...rest } = w;
        return { ...rest, tags: [...tags], kol: t.name };
      }
      if (t) {
        tags.add("tracked");
        return { ...w, tags: [...tags], tracked: t.name };
      }
      if (s && !tags.has("kol") && !w.side) {
        tags.add("side");
        return {
          ...w,
          tags: [...tags],
          side: {
            kind: s.funded ? "funded" : "probable",
            kolWallet: s.kolWallet,
            kolName: s.kolName,
            ...(s.tracked ? { tracked: s.tracked } : {}),
          },
        };
      }
      return w;
    };
    const i = at.get(r.wallet);
    if (i !== undefined) {
      out[i] = patch(out[i]!);
      continue;
    }
    if (added >= MAX_TRACKED_MARKED_WALLETS || budget <= 0) continue;
    const trades = (storedTrades(r.trades) ?? firstTrades(r)).slice(0, budget);
    if (trades.length === 0) continue;
    budget -= trades.length;
    added += 1;
    at.set(r.wallet, out.length);
    out.push(
      patch({
        wallet: r.wallet,
        tags: r.isCreator ? ["creator"] : [],
        score: null,
        dumps: null,
        coins: null,
        funder: null,
        kol: null,
        solIn: r.solIn,
        solOut: r.solOut,
        heldPct: r.heldPctAtAnchor,
        trades,
      }),
    );
  }
  return out;
}

/** Riskiest first (creator, KOL and linked wallets ahead of unscored ones), within the caps. */
function rankAndCap(wallets: MarkedWallet[]): MarkedWallet[] {
  // A label is a floor under the score, not an answer in its place: a KOL with a low score (most
  // trade enough coins to carry one) ranked under every unscored linked wallet, and on a coin with
  // MAX_MARKED_WALLETS of those its marks never showed.
  const weight = (w: MarkedWallet) =>
    (w.tags.includes("creator") ? 1_000 : 0) +
    Math.max(
      w.score ?? 0,
      w.tags.includes("kol") || w.tags.includes("winner")
        ? 60
        : w.tags.includes("side")
          ? 55
          : w.funder
            ? 50
            : 0,
    ) +
    w.solIn / 1_000;
  wallets.sort((a, b) => weight(b) - weight(a));
  const kept = wallets.slice(0, MAX_MARKED_WALLETS);
  let budget = MAX_MARKED_TRADES;
  for (const w of kept) {
    if (w.trades.length > budget) w.trades = w.trades.slice(0, Math.max(0, budget));
    budget -= w.trades.length;
  }
  return kept.filter((w) => w.trades.length > 0);
}

/** A row's stored trades (StoredTrade in core's tradeTape.ts) as marked trades; null when absent. */
function storedTrades(raw: unknown): MarkedTrade[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MarkedTrade[] = [];
  for (const t of raw) {
    if (!Array.isArray(t)) continue;
    const [at, side, sol] = t as unknown[];
    if (typeof at !== "number" || !Number.isFinite(at) || (side !== 1 && side !== -1)) continue;
    out.push([at, side, typeof sol === "number" && Number.isFinite(sol) ? sol : null]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** A row read before the tape kept every trade: its first buy and first sell, without amounts. */
function firstTrades(r: ActivityRow): MarkedTrade[] {
  const out: MarkedTrade[] = [];
  if (r.firstBuyAt) out.push([r.firstBuyAt.getTime(), 1, null]);
  if (r.firstSellAt) out.push([r.firstSellAt.getTime(), -1, null]);
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * A per-key, single-flight TTL cache for answers that are the same for every reader of one coin
 * (the token modal's wallet markers), bounded to `maxEntries` keys, least recently read first out.
 * A failed fill is kept only `failureTtlMs` (none by default): a heavy fill that fails on a busy
 * database then isn't rerun by every retry at once (charts audit item 6).
 */
export class KeyedCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 300,
    private readonly now: () => number = Date.now,
    private readonly failureTtlMs = 0,
  ) {}

  get(key: string, fill: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.entries.get(key);
    this.entries.delete(key);
    if (hit && hit.expiresAt > now) {
      this.entries.set(key, hit);
      return hit.value;
    }
    const value = fill();
    value.catch(() => {
      const entry = this.entries.get(key);
      if (entry?.value !== value) return;
      if (this.failureTtlMs > 0) entry.expiresAt = Math.min(entry.expiresAt, this.now() + this.failureTtlMs);
      else this.entries.delete(key);
    });
    this.entries.set(key, { expiresAt: now + this.ttlMs, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  /** Drops a key's answer, so its next reader fills it again. */
  forget(key: string): void {
    this.entries.delete(key);
  }
}

/**
 * The last good answer per key, the `maxEntries` most recently set (oldest out first): what a read
 * that failed answers instead of nothing.
 */
export class LastGood<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly maxEntries = 300) {}

  get(key: string): T | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** One flagged trade kept on a snapshot by the live tape (core's wallets/liveFlags.ts FlaggedTrade). */
interface LiveTrade {
  wallet: string;
  side: 1 | -1;
  sol: number | null;
  atMs: number;
  score: number;
  dumps: number;
}

/** Two readings of one trade (the live tape and the post-call tape) within this much of each other. */
const SAME_TRADE_MS = 2_000;

/** A snapshot's flaggedTrades, the well-formed ones. */
export function parseLiveTrades(raw: unknown): LiveTrade[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveTrade[] = [];
  for (const t of raw as Record<string, unknown>[]) {
    if (!t || typeof t.wallet !== "string" || typeof t.atMs !== "number" || !Number.isFinite(t.atMs))
      continue;
    if (t.side !== "buy" && t.side !== "sell") continue;
    out.push({
      wallet: t.wallet,
      side: t.side === "buy" ? 1 : -1,
      sol: typeof t.sol === "number" && Number.isFinite(t.sol) ? t.sol : null,
      atMs: t.atMs,
      score: typeof t.score === "number" ? t.score : 0,
      dumps: typeof t.dumps === "number" ? t.dumps : 0,
    });
  }
  return out;
}

/**
 * Exported for tests. The marked wallets with the flagged trades the live tape read before the
 * call (each snapshot keeps its newest few) folded in: a wallet the post-call tape hasn't read
 * yet joins with its live trades, one it has gets any live trade the tape doesn't hold. So the
 * modal marks risky wallets and known dumpers from the call on, and the tape later fills in the
 * linked and dev wallets and the trades after it. A wallet's current score (WalletRisk) wins over
 * the one its trade was read with.
 */
export function withLiveTrades(
  marked: readonly MarkedWallet[],
  live: readonly LiveTrade[],
  risk: ReadonlyMap<string, RiskRow>,
  opts: MarkOpts,
): MarkedWallet[] {
  if (live.length === 0) return [...marked];
  const byWallet = new Map(marked.map((w) => [w.wallet, { ...w, tags: [...w.tags], trades: [...w.trades] }]));
  // Wallets known only from the live tape: their SOL in and out are what it saw.
  const liveOnly = new Set<string>();
  for (const t of live) {
    let w = byWallet.get(t.wallet);
    if (!w) {
      const k = risk.get(t.wallet);
      const score = k?.score ?? t.score;
      const dumps = k?.dumps ?? t.dumps;
      const tags: WalletTag[] = [];
      if (score >= opts.riskyScore) tags.push("risky");
      if (k?.dumper) tags.push("dumper");
      if (k?.winner) tags.push("winner");
      // Flagged when read; a later score may have dropped it, but the trade is still worth marking.
      if (tags.length === 0) tags.push(t.score >= opts.riskyScore ? "risky" : "dumper");
      w = {
        wallet: t.wallet,
        tags,
        score,
        dumps,
        coins: k?.appearances ?? null,
        funder: null,
        solIn: 0,
        solOut: 0,
        heldPct: null,
        trades: [],
      };
      byWallet.set(t.wallet, w);
      liveOnly.add(t.wallet);
    }
    if (w.trades.some(([at, side]) => side === t.side && Math.abs(at - t.atMs) <= SAME_TRADE_MS)) continue;
    w.trades.push([t.atMs, t.side, t.sol]);
    if (liveOnly.has(t.wallet)) {
      if (t.side === 1) w.solIn += t.sol ?? 0;
      else w.solOut += t.sol ?? 0;
    }
  }
  for (const w of byWallet.values()) w.trades.sort((a, b) => a[0] - b[0]);
  return rankAndCap([...byWallet.values()]);
}
