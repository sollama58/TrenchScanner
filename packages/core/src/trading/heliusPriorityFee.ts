import { fetchJson } from "../datasources/httpClient.js";

/**
 * Helius's own priority fee estimate (https://www.helius.dev/docs/priority-fee-api): what
 * transactions writing the given accounts are paying now, at a chosen level of the recent
 * distribution. Better in a busy minute than getRecentPrioritizationFees, whose per-slot minimums
 * sit near zero while trades on a hot coin pay far more.
 *
 * Only Helius endpoints serve it; anywhere else (and on any failure) this answers null and the
 * caller falls back to getRecentPrioritizationFees (TradingRpc.getPriorityFeeEstimate).
 */

/** Helius's levels: the percentile of recent fees each stands for (High 75th, VeryHigh 95th). */
export type HeliusPriorityLevel = "Medium" | "High" | "VeryHigh";

/** Short: the estimate sits on the path of a trade, and the fallback is one call away. */
const HELIUS_FEE_TIMEOUT_MS = 2_500;
/** The most account keys the API reads (Helius's limit, as getRecentPrioritizationFees'). */
const MAX_ACCOUNT_KEYS = 128;

/** Whether an RPC URL is a Helius endpoint (mainnet.helius-rpc.com, a dedicated node...). */
export function isHeliusRpcUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "helius-rpc.com" || host.endsWith(".helius-rpc.com");
  } catch {
    return false;
  }
}

/**
 * Helius's estimate for a transaction writing `accountKeys`, micro-lamports per compute unit.
 * Null when `url` isn't Helius, or it didn't answer with a number.
 */
export async function heliusPriorityFeeEstimate(
  url: string | null | undefined,
  accountKeys: string[],
  priorityLevel: HeliusPriorityLevel,
  timeoutMs = HELIUS_FEE_TIMEOUT_MS,
): Promise<bigint | null> {
  if (!url || !isHeliusRpcUrl(url) || accountKeys.length === 0) return null;
  try {
    const body = await fetchJson<{ result?: { priorityFeeEstimate?: unknown }; error?: unknown }>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getPriorityFeeEstimate",
        params: [{ accountKeys: accountKeys.slice(0, MAX_ACCOUNT_KEYS), options: { priorityLevel } }],
      }),
      timeoutMs,
      retries: 0,
    });
    const fee = body.result?.priorityFeeEstimate;
    if (typeof fee !== "number" || !Number.isFinite(fee) || fee < 0) return null;
    return BigInt(Math.floor(fee));
  } catch {
    return null;
  }
}
