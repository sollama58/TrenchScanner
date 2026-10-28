import { fetchJson } from "./httpClient.js";

/**
 * Solana Tracker's Data API (data.solanatracker.io), for its roster of known KOL wallets: the KOL
 * leaderboard (GET /v2/pnl/leaderboard/kols) lists every wallet on the roster with its name and X
 * handle. Read once a day by the worker's kol-wallets job into KolWallet. Also a coin's most
 * profitable traders of all time (GET /v2/pnl/tokens/{mint}/traders), for Asyl's Top profitable
 * wallets (user ask 2026-10-27). The free plan allows 10,000 requests a month and 3 a second.
 */

export interface KolEntry {
  wallet: string;
  name: string | null;
  /** The X handle without its "@" (Solana Tracker sometimes sends "@@name"). */
  twitter: string | null;
  realizedPnlUsd: number | null;
  winRate: number | null;
  lastTradeAt: Date | null;
}

export interface KolPage {
  kols: KolEntry[];
  nextCursor: string | null;
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HANDLE = /^[A-Za-z0-9_]{1,30}$/;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max = 80) =>
  typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, max) : null;

/** One leaderboard page as KolEntry rows; rows without a valid address are dropped. Exported for tests. */
export function parseKolPage(body: unknown): KolPage {
  const b = (body ?? {}) as { traders?: unknown; pagination?: { nextCursor?: unknown; hasMore?: unknown } };
  const kols: KolEntry[] = [];
  for (const raw of Array.isArray(b.traders) ? b.traders : []) {
    const t = (raw ?? {}) as Record<string, unknown>;
    const wallet = typeof t.wallet === "string" ? t.wallet : "";
    if (!ADDRESS.test(wallet)) continue;
    const identity = (t.identity ?? {}) as Record<string, unknown>;
    const handle = text(identity.twitter)?.replace(/^@+/, "") ?? null;
    const lastTrade = num((t.timing as Record<string, unknown> | undefined)?.lastTrade);
    kols.push({
      wallet,
      name: text(identity.name),
      twitter: handle && HANDLE.test(handle) ? handle : null,
      realizedPnlUsd: num((t.pnl as Record<string, unknown> | undefined)?.realized),
      winRate: num(t.winRate),
      lastTradeAt: lastTrade !== null ? new Date(lastTrade) : null,
    });
  }
  const cursor = b.pagination?.hasMore === false ? null : text(b.pagination?.nextCursor, 2_000);
  return { kols, nextCursor: cursor };
}

/** One wallet's trading of one coin, all time, as Solana Tracker works it out (USD). */
export interface TokenTrader {
  wallet: string;
  /** Profit on this coin: realised plus what it still holds, at the current price. */
  pnlUsd: number;
  realizedUsd: number | null;
  unrealizedUsd: number | null;
  investedUsd: number | null;
  proceedsUsd: number | null;
  buys: number;
  sells: number;
  /** Coins it still holds; 0 when sold out. */
  balance: number;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  /** Its profit across every coin it traded, and how many coins. */
  walletPnlUsd: number | null;
  tokensTraded: number | null;
}

export interface TokenTradersPage {
  traders: TokenTrader[];
  nextCursor: string | null;
  /** Every wallet that traded it, as Solana Tracker counts them. */
  total: number | null;
}

/** One page of a coin's traders; rows without a valid address or a profit are dropped. Exported for tests. */
export function parseTokenTraders(body: unknown): TokenTradersPage {
  const b = (body ?? {}) as {
    traders?: unknown;
    pagination?: { nextCursor?: unknown; hasMore?: unknown; total?: unknown };
  };
  const traders: TokenTrader[] = [];
  for (const raw of Array.isArray(b.traders) ? b.traders : []) {
    const t = (raw ?? {}) as Record<string, unknown>;
    const wallet = typeof t.wallet === "string" ? t.wallet : "";
    const pnl = (t.pnl ?? {}) as { token?: Record<string, unknown>; wallet?: Record<string, unknown> };
    const total = num(pnl.token?.total);
    if (!ADDRESS.test(wallet) || total === null) continue;
    const counts = (t.counts ?? {}) as Record<string, unknown>;
    const current = (t.current ?? t.position ?? {}) as Record<string, unknown>;
    const timing = (t.timing ?? {}) as Record<string, unknown>;
    traders.push({
      wallet,
      pnlUsd: total,
      realizedUsd: num(pnl.token?.realized),
      unrealizedUsd: num(pnl.token?.unrealized),
      investedUsd: num(t.invested) ?? num(t.buyUsd),
      proceedsUsd: num(t.proceeds) ?? num(t.sellUsd),
      buys: num(counts.buys) ?? 0,
      sells: num(counts.sells) ?? 0,
      balance: num(current.balance) ?? 0,
      firstTradeAt: num(timing.firstTrade),
      lastTradeAt: num(timing.lastTrade),
      walletPnlUsd: num(pnl.wallet?.total),
      tokensTraded: num(pnl.wallet?.tokensTraded),
    });
  }
  const cursor = b.pagination?.hasMore === false ? null : text(b.pagination?.nextCursor, 2_000);
  return { traders, nextCursor: cursor, total: num(b.pagination?.total) };
}

/** Solana Tracker allows 3 requests a second: each client's calls are spaced at least this far apart. */
export const SOLANA_TRACKER_GAP_MS = 350;

export class SolanaTrackerClient {
  private nextAt = 0;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://data.solanatracker.io",
    private readonly gapMs = SOLANA_TRACKER_GAP_MS,
  ) {}

  /** Waits for this call's turn under the plan's rate (per process: the API and worker each keep their own). */
  private async turn(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.gapMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  /** One page of the KOL roster, most realised profit first. */
  async kolPage(cursor: string | null, limit = 100): Promise<KolPage> {
    const url = new URL(`${this.baseUrl}/v2/pnl/leaderboard/kols`);
    url.searchParams.set("sort", "realized");
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    await this.turn();
    const body = await fetchJson<unknown>(url.toString(), {
      headers: { "x-api-key": this.apiKey },
      timeoutMs: 15_000,
      retries: 2,
      retryDelayMs: 1_000,
    });
    return parseKolPage(body);
  }

  /** One page of a coin's traders, most profit on it first (arbitrage bots and airdrops left out, as Solana Tracker does by default). */
  async tokenTraders(mint: string, cursor: string | null, limit = 100): Promise<TokenTradersPage> {
    const url = new URL(`${this.baseUrl}/v2/pnl/tokens/${encodeURIComponent(mint)}/traders`);
    url.searchParams.set("sort", "pnl");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    await this.turn();
    // No retry: each call is one of Asyl's capped calls (apps/api/src/asyl/topTraders.ts), and
    // the reader can ask again.
    const body = await fetchJson<unknown>(url.toString(), {
      headers: { "x-api-key": this.apiKey },
      timeoutMs: 15_000,
      retries: 0,
    });
    return parseTokenTraders(body);
  }
}
