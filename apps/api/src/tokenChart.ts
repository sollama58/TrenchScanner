import { createLogger, fetchJson, HttpError, PUMP_SUPPLY_TOKENS, pumpFunSwapGate } from "@trenchscanner/core";

const logger = createLogger("token-chart");

/** One minute of a coin's trading, priced as market cap (USD price x Pump.fun's one billion supply). */
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

export interface CandleCacheOptions {
  /** How long one coin's answer is reused: every reader of a coin within it shares one call. */
  ttlMs?: number;
  /** Pump.fun calls allowed per rolling minute across every reader; past it, readers get null. */
  callsPerMinute?: number;
  /** Coins kept; the least recently read one goes first. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * The token modal's candles, per coin, single-flight and on a call budget: the first reader of a
 * coin starts the one Pump.fun call and everyone else in the TTL shares it. Over budget (or when
 * the call fails) the answer is null and the modal falls back to the scan's market caps, so a
 * burst of readers never turns into a burst of upstream calls.
 */
export class CandleCache {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<McapCandle[] | null> }>();
  private readonly calls: number[] = [];
  private readonly ttlMs: number;
  private readonly callsPerMinute: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly fetcher: CandleFetcher,
    opts: CandleCacheOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.callsPerMinute = opts.callsPerMinute ?? 60;
    this.maxEntries = opts.maxEntries ?? 300;
    this.now = opts.now ?? Date.now;
  }

  get(mint: string): Promise<McapCandle[] | null> {
    const now = this.now();
    const hit = this.entries.get(mint);
    if (hit && hit.expiresAt > now) {
      // Re-inserted so the Map's order stays least-recently-read first.
      this.entries.delete(mint);
      this.entries.set(mint, hit);
      return hit.value;
    }
    while (this.calls.length > 0 && this.calls[0]! <= now - 60_000) this.calls.shift();
    // Over budget: an expired answer still beats none.
    if (this.calls.length >= this.callsPerMinute) return hit ? hit.value : Promise.resolve(null);
    this.calls.push(now);
    const value = this.fetcher(mint).catch((err: unknown) => {
      logger.warn("candles failed", { mint, error: String(err) });
      // A failure is remembered only briefly, so the next reader soon tries again.
      const entry = this.entries.get(mint);
      if (entry?.value === value) entry.expiresAt = Math.min(entry.expiresAt, this.now() + 5_000);
      return null;
    });
    this.entries.delete(mint);
    this.entries.set(mint, { expiresAt: now + this.ttlMs, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }
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
export type WalletTag = "risky" | "dumper" | "linked" | "creator" | "kol" | "winner" | "side";

/** A KOL side label short of a Known Side (possibleSides.ts): a wallet a KOL funded, or a Probable Side. */
export interface SideLabel {
  kind: "funded" | "probable";
  /** The KOL's main wallet, and its roster name (null when it has none). */
  kolWallet: string;
  kolName: string | null;
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

/** Riskiest first (creator, KOL and linked wallets ahead of unscored ones), within the caps. */
function rankAndCap(wallets: MarkedWallet[]): MarkedWallet[] {
  const weight = (w: MarkedWallet) =>
    (w.tags.includes("creator") ? 1_000 : 0) +
    (w.score ??
      (w.tags.includes("kol") || w.tags.includes("winner")
        ? 60
        : w.tags.includes("side")
          ? 55
          : w.funder
            ? 50
            : 0)) +
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
 * A failed fill is not kept.
 */
export class KeyedCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 300,
    private readonly now: () => number = Date.now,
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
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
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
