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
  /** The name is a Pump.fun username (Helius's `"NAME" on Pumpfun`), shortened to NAME. */
  pumpfun?: boolean;
  /** The name is a FOMO app username (`"NAME" on FOMO`), shortened to NAME. */
  fomo?: boolean;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

/**
 * `"NAME" on Pumpfun` (Pump.fun usernames, as Helius names them) or `"NAME" on FOMO` (the FOMO
 * app's; inferred to follow the same pattern), with straight or curly quotes.
 */
const USERNAME_RE = /^["\u201c\u201d](.+?)["\u201c\u201d]\s+on\s+(pump\.?\s?fun|fomo(?:\.family)?)$/i;

/** The app a Helius name is a username on, if it is one. */
export function usernameApp(name: string): "pumpfun" | "fomo" | null {
  const m = USERNAME_RE.exec(name.trim());
  if (!m) return null;
  return m[2]!.toLowerCase().startsWith("fomo") ? "fomo" : "pumpfun";
}

/** Whether Helius's name is a Pump.fun username (`"NAME" on Pumpfun`). */
export function isPumpfunName(name: string): boolean {
  return usernameApp(name) === "pumpfun";
}

/** A name followed by an X handle and maybe more: `NAME @handle …` or `NAME (@handle) …`. */
const HANDLE_RE = /^(.*?\S)\s+\(?@[A-Za-z0-9_]/;

/** A name without its X handle and anything after it ("NAME @HANDLE …" → "NAME"); a bare "@handle" stays. */
export function withoutHandle(name: string): string {
  const m = HANDLE_RE.exec(name.trim());
  // "NAME - @handle" or "NAME | @handle" leaves no separator behind.
  return (m && m[1]!.replace(/[\s|:,\u00b7\u2013\u2014-]+$/, "")) || name.trim();
}

/**
 * A wallet's name as the dashboard keeps it: a Pump.fun or FOMO username labelled
 * `"NAME" on Pumpfun` / `"NAME" on FOMO` becomes just NAME (user asks 2026-10-13 and 14; the
 * dashboard quotes and tints it), and an X handle and anything after it is dropped ("NAME @HANDLE …" → "NAME",
 * user ask 2026-10-16); anything else is left as it is.
 */
export function cleanWalletName(name: string): string {
  const m = USERNAME_RE.exec(name.trim());
  return m ? m[1]!.trim() : withoutHandle(name);
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
  const app = name ? usernameApp(name) : null;
  if (app === "pumpfun") value.pumpfun = true;
  if (app === "fomo") value.fomo = true;
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
