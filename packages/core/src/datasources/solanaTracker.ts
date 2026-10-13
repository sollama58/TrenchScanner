import { fetchJson } from "./httpClient.js";

/**
 * Solana Tracker's Data API (data.solanatracker.io), for its roster of known KOL wallets: the KOL
 * leaderboard (GET /v2/pnl/leaderboard/kols) lists every wallet on the roster with its name and X
 * handle. Read once a day by the worker's kol-wallets job into KolWallet. The free plan allows
 * 10,000 requests a month and 3 a second.
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

export class SolanaTrackerClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://data.solanatracker.io",
  ) {}

  /** One page of the KOL roster, most realised profit first. */
  async kolPage(cursor: string | null, limit = 100): Promise<KolPage> {
    const url = new URL(`${this.baseUrl}/v2/pnl/leaderboard/kols`);
    url.searchParams.set("sort", "realized");
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    const body = await fetchJson<unknown>(url.toString(), {
      headers: { "x-api-key": this.apiKey },
      timeoutMs: 15_000,
      retries: 2,
      retryDelayMs: 1_000,
    });
    return parseKolPage(body);
  }
}
