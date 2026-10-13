import { fetchJson, HttpError } from "./httpClient.js";
import { createLogger } from "../logger.js";

const logger = createLogger("wallet-identity");

/**
 * Who a wallet is, from Helius's identity list (exchanges, protocols, known services), for the
 * wallet modal. Read one wallet at a time, when someone opens it; the API caches the answers.
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
      const value: HeliusIdentity = {
        type: str(raw.type),
        name: str(raw.name),
        category: str(raw.category),
        tags: strings(raw.tags),
      };
      if (!value.name && value.tags.length === 0) return { status: "none" };
      return { status: "found", value };
    } catch (err) {
      // 404 is the documented answer for a wallet nobody has named.
      if (err instanceof HttpError && err.status === 404) return { status: "none" };
      if (err instanceof HttpError && (err.status === 401 || err.status === 403))
        return { status: "unavailable" };
      logger.warn("Helius identity read failed", { error: String(err) });
      return { status: "failed" };
    }
  }
}
