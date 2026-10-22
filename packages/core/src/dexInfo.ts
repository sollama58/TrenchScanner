/**
 * DexScreener enhanced token info (user ask 2026-10-21): a project pays to add or update the
 * token's profile, links, images and description. Two public signals, neither invented here.
 *
 * The pair response already fetched for pricing includes an `info` block only once that
 * profile exists (docs: info is absent until the profile is claimed). That says the token has
 * DexScreener info, and it has no payment time.
 *
 * GET /orders/v1/{chainId}/{tokenAddress} lists the payments. A tokenProfile or
 * communityTakeover order is a token-info payment; ads and boosts are not. paymentTimestamp
 * in the published examples is unix seconds (1700000000). A value of 1e12 or more is already
 * milliseconds, the same unit as pairCreatedAt. A missing or unreadable time is left missing.
 */

export const DEX_INFO_ORDER_TYPES = ["tokenProfile", "communityTakeover"] as const;
export type DexInfoOrderType = (typeof DEX_INFO_ORDER_TYPES)[number];

/** Statuses that mean the payment was made. Cancelled and rejected are not shown. */
const PAID_STATUSES = new Set(["approved", "processing", "on-hold"]);

/** How many order lookups one scan cycle may make (the discovery budget is 30 a minute). */
export const DEX_INFO_ORDERS_PER_CYCLE = 4;
/** A mint seen on the latest profile or takeover feed is asked again after this. */
export const DEX_INFO_RECHECK_MS = 60 * 60_000;

export interface DexInfoPayment {
  type: DexInfoOrderType;
  /** "paid" when this is the only token-info payment, "updated" when a later one is newest. */
  updated: boolean;
  paidAtMs: number;
}

/** One mint's orders response: a payment, or null when the response listed none that count. */
export interface DexInfoOrderRead {
  mint: string;
  payment: DexInfoPayment | null;
}

/**
 * The newest token-info payment in a DexScreener orders response, or null when the response
 * has none. Accepts the documented array and a wrapped `{ orders: [...] }` of the same rows.
 * Does not guess a time when paymentTimestamp is missing.
 */
export function readDexInfoPayment(body: unknown): DexInfoPayment | null {
  const rows = orderRows(body);
  const counted: { type: DexInfoOrderType; paidAtMs: number }[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const type = rec.type;
    if (type !== "tokenProfile" && type !== "communityTakeover") continue;
    const status = typeof rec.status === "string" ? rec.status : "";
    if (!PAID_STATUSES.has(status)) continue;
    const paidAtMs = paymentMs(rec.paymentTimestamp);
    if (paidAtMs === null) continue;
    counted.push({ type, paidAtMs });
  }
  if (counted.length === 0) return null;
  counted.sort((a, b) => a.paidAtMs - b.paidAtMs);
  const latest = counted[counted.length - 1]!;
  return { type: latest.type, paidAtMs: latest.paidAtMs, updated: counted.length > 1 };
}

/**
 * What one orders read does to the stored Dex bubble.
 * `undefined` (the mint was not in the answer: the call failed) leaves the stored payment alone.
 * A missing read is not a newer payment.
 * `null` (the call answered and no token-info payment counts) clears the stored time, so a
 * cancelled newest order does not leave the previous bubble forever.
 * A payment replaces the stored time even when it is older than what we had saved.
 */
export function nextDexPayment(
  payment: DexInfoPayment | null | undefined,
): { paidAtMs: number | null; updated: boolean } | undefined {
  if (payment === undefined) return undefined;
  if (payment === null) return { paidAtMs: null, updated: false };
  return { paidAtMs: payment.paidAtMs, updated: payment.updated };
}

/** True when a pair response carried an info block (the profile exists). No time comes with it. */
export function pairHasTokenInfo(info: unknown): boolean {
  return !!info && typeof info === "object";
}

/**
 * Which mints to ask the orders endpoint for this cycle: profile and takeover mints not checked
 * in the last hour, then tokens we already know have info but have never been asked, up to `cap`.
 */
export function dexInfoMintsToAsk(
  priority: readonly string[],
  known: readonly { mintAddress: string; dexInfoCheckedAt: Date | null }[],
  backfill: readonly string[],
  now: number,
  cap = DEX_INFO_ORDERS_PER_CYCLE,
): string[] {
  const checked = new Map(known.map((r) => [r.mintAddress, r.dexInfoCheckedAt]));
  const due = priority.filter((mint) => {
    const at = checked.get(mint);
    return at == null || now - at.getTime() >= DEX_INFO_RECHECK_MS;
  });
  const seen = new Set(due);
  const rest = backfill.filter((mint) => !seen.has(mint));
  const limit = cap > 0 && Number.isFinite(cap) ? cap : DEX_INFO_ORDERS_PER_CYCLE;
  return [...due, ...rest].slice(0, limit);
}

function orderRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && Array.isArray((body as { orders?: unknown }).orders)) {
    return (body as { orders: unknown[] }).orders;
  }
  return [];
}

/** Unix seconds, or milliseconds when the value is already 1e12 or more. Null when it is not a time. */
function paymentMs(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n >= 1e12 ? n : n >= 1e9 ? n * 1000 : NaN;
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms);
}
