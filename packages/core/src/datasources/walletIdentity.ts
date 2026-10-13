import { fetchJson, HttpError } from "./httpClient.js";
import { createLogger } from "../logger.js";

const logger = createLogger("wallet-identity");

/**
 * Who a wallet is, from Helius's identity list (exchanges, protocols, known services), for the
 * wallet modal (one wallet, when someone opens it) and the dashboard's holder lists (a batch of up
 * to 100). The API caches the answers.
 */

/** "unavailable": the plan or key can't read it (a 401/403). */
export type IdentityRead<T> =
  { status: "found"; value: T } | { status: "none" } | { status: "unavailable" } | { status: "failed" };

export interface HeliusIdentity {
  /** "exchange", "protocol", ... */
  type: string | null;
  name: string | null;
  category: string | null;
  tags: string[];
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

/** `"NAME" on Pumpfun` (Pump.fun usernames, as Helius names them), with straight or curly quotes. */
const PUMPFUN_NAME_RE = /^["\u201c\u201d](.+?)["\u201c\u201d]\s+on\s+pump\.?\s?fun$/i;

/**
 * A wallet's name as the dashboard shows it: a Pump.fun username labelled `"NAME" on Pumpfun`
 * becomes just NAME (user ask 2026-10-13); anything else is left as it is.
 */
export function cleanWalletName(name: string): string {
  const m = PUMPFUN_NAME_RE.exec(name.trim());
  return m ? m[1]!.trim() : name.trim();
}

/** One identity entry, or null when Helius names nothing (no name and no tags). */
function parseIdentity(raw: Record<string, unknown>): HeliusIdentity | null {
  const name = str(raw.name);
  const value: HeliusIdentity = {
    type: str(raw.type),
    name: name ? cleanWalletName(name) : null,
    category: str(raw.category),
    tags: strings(raw.tags).map(cleanWalletName),
  };
  return value.name || value.tags.length > 0 ? value : null;
}

/** The most addresses one batch-identity call takes. */
export const IDENTITY_BATCH_MAX = 100;

/** Helius's Wallet API identity lookup (GET /v1/wallet/{address}/identity). Needs a paid plan; 100 credits a call. */
export class HeliusIdentityClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.helius.xyz",
  ) {}

  async identity(wallet: string): Promise<IdentityRead<HeliusIdentity>> {
    try {
      const raw = await fetchJson<Record<string, unknown>>(
        `${this.baseUrl}/v1/wallet/${encodeURIComponent(wallet)}/identity`,
        { headers: { "X-Api-Key": this.apiKey }, timeoutMs: 8_000, retries: 1 },
      );
      const value = parseIdentity(raw);
      return value ? { status: "found", value } : { status: "none" };
    } catch (err) {
      // 404 is the documented answer for a wallet nobody has named.
      if (err instanceof HttpError && err.status === 404) return { status: "none" };
      if (err instanceof HttpError && (err.status === 401 || err.status === 403))
        return { status: "unavailable" };
      logger.warn("Helius identity read failed", { error: String(err) });
      return { status: "failed" };
    }
  }

  /**
   * Up to IDENTITY_BATCH_MAX wallets in one call (POST /v1/wallet/batch-identity): every wallet
   * asked for, mapped to its identity or null when Helius names nothing.
   */
  async batchIdentity(wallets: readonly string[]): Promise<IdentityRead<Map<string, HeliusIdentity | null>>> {
    const asked = wallets.slice(0, IDENTITY_BATCH_MAX);
    try {
      const raw = await fetchJson<unknown>(`${this.baseUrl}/v1/wallet/batch-identity`, {
        method: "POST",
        headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ addresses: asked }),
        timeoutMs: 10_000,
        retries: 1,
      });
      const out = new Map<string, HeliusIdentity | null>(asked.map((w) => [w, null]));
      if (Array.isArray(raw))
        for (const entry of raw) {
          if (!entry || typeof entry !== "object") continue;
          const e = entry as Record<string, unknown>;
          const address = str(e.address);
          if (address && out.has(address)) out.set(address, parseIdentity(e));
        }
      return { status: "found", value: out };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403))
        return { status: "unavailable" };
      logger.warn("Helius batch identity read failed", { error: String(err) });
      return { status: "failed" };
    }
  }
}
