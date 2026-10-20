import { fetchJson, HttpError } from "../datasources/httpClient.js";

/**
 * Helius Sender (https://www.helius.dev/docs/sending-transactions/sender): the low-latency send
 * path the token modal's Pro trades take. It costs no API credits and charges no fee of its own;
 * each transaction pays it a SOL tip instead, to one of the accounts below, plus a priority fee.
 *
 * Two tiers, chosen per trade:
 *   - "eco" (swqos_only=true): one fast path, a tip of 0.000005 SOL at least. The default: the
 *     point of in-modal trading is that it costs next to nothing.
 *   - "turbo" (Sender Max): every pathway Helius has, a tip of 0.001 SOL at least - for a launch
 *     where a slot matters more than a cent.
 * MEV Protect (mev-protect=true) keeps the transaction away from validators known for sandwiching
 * and works on both tiers; it is on unless the trader turns it off.
 */

export const HELIUS_SENDER_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
] as const;

const TIP_ACCOUNTS = new Set<string>(HELIUS_SENDER_TIP_ACCOUNTS);

export const DEFAULT_HELIUS_SENDER_URL = "https://sender.helius-rpc.com/fast";

export type SenderSpeed = "eco" | "turbo";

/** Each tier's minimum tip (lamports): what Sender accepts on that path. */
export const SENDER_MIN_TIP_LAMPORTS: Record<SenderSpeed, bigint> = {
  eco: 5_000n,
  turbo: 1_000_000n,
};

/** One of the tip accounts, at random, so concurrent senders don't all write the same account. */
export function pickSenderTipAccount(random: () => number = Math.random): string {
  return HELIUS_SENDER_TIP_ACCOUNTS[Math.floor(random() * HELIUS_SENDER_TIP_ACCOUNTS.length)]!;
}

export function isSenderTipAccount(address: string): boolean {
  return TIP_ACCOUNTS.has(address);
}

/** The endpoint for a tier: the base URL with its query (and the API key, when there is one). */
export function senderUrl(
  base: string,
  options: { speed: SenderSpeed; mevProtect: boolean; apiKey?: string },
): string {
  const url = new URL(base || DEFAULT_HELIUS_SENDER_URL);
  // The base URL may already carry a tier (a saved eco endpoint). Set the one this trade asked
  // for, and take the other off, so Turbo is not sent down the eco path or the other way round.
  if (options.speed === "eco") url.searchParams.set("swqos_only", "true");
  else url.searchParams.delete("swqos_only");
  if (options.mevProtect) url.searchParams.set("mev-protect", "true");
  else url.searchParams.delete("mev-protect");
  if (options.apiKey) url.searchParams.set("api-key", options.apiKey);
  return url.toString();
}

/** What Sender said to one send: took it, refused it (nothing went out), or no clear answer. */
export type SenderResult = { ok: true } | { ok: false; refused: boolean; error: string };

/**
 * Sends one signed transaction (base64) to Sender. Never throws: whether it landed is for the
 * signature's status to say. Only a JSON-RPC error is a refusal; a timeout or a dropped
 * connection may still have gone out, so it is `refused: false` and must be treated as sent.
 *
 * A keyed URL whose key Sender turns away (401/403, or 429 on the key's own limit: a suspended or
 * over-limit Helius account) is tried once more without the key, on Sender's keyless limit. Only
 * after a refusal, when nothing went out (and the same signed bytes can land only once anyway).
 */
export async function sendViaSender(url: string, base64Tx: string): Promise<SenderResult> {
  const first = await sendOnce(url, base64Tx);
  if (first.ok || !KEY_REFUSALS.has(first.status ?? 0)) return strip(first);
  const keyless = withoutApiKey(url);
  if (!keyless) return strip(first);
  return strip(await sendOnce(keyless, base64Tx));
}

/** The URL without its api-key parameter; null when it had none. */
function withoutApiKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("api-key")) return null;
    parsed.searchParams.delete("api-key");
    return parsed.toString();
  } catch {
    return null;
  }
}

/** HTTP answers that refuse the key rather than the transaction. */
const KEY_REFUSALS = new Set([401, 403, 429]);

type SendAttempt = { ok: true } | { ok: false; refused: boolean; error: string; status?: number };

const strip = (r: SendAttempt): SenderResult =>
  r.ok ? r : { ok: false, refused: r.refused, error: r.error };

async function sendOnce(url: string, base64Tx: string): Promise<SendAttempt> {
  let body: { result?: unknown; error?: { message?: string } };
  try {
    body = await fetchJson<{ result?: unknown; error?: { message?: string } }>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [base64Tx, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
      }),
      timeoutMs: 8_000,
      retries: 0,
    });
  } catch (err) {
    // A 4xx answer (rate limit included) is Sender saying no; a timeout or a 5xx may have gone out.
    const status = err instanceof HttpError ? err.status : 0;
    const refused = status >= 400 && status < 500 && status !== 408;
    return { ok: false, refused, error: err instanceof Error ? err.message : String(err), status };
  }
  if (body.error)
    return { ok: false, refused: true, error: body.error.message ?? "Sender refused the transaction" };
  return { ok: true };
}

/**
 * Whether Sender answers at all: its GET /ping on the endpoint's host, keyless and free. Never
 * throws. Only a health signal for the trade panel; a send's own answer says more.
 */
export async function pingSender(base: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const url = new URL("/ping", base || DEFAULT_HELIUS_SENDER_URL);
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}
