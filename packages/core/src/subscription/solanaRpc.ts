import { fetchJson } from "../datasources/httpClient.js";
import { createLogger } from "../logger.js";
import type { ParsedTransaction } from "./parseBurn.js";

const logger = createLogger("solana-rpc");

/** Public mainnet RPC. Rate-limited and fine for a low-volume path, but Helius is preferred. */
const PUBLIC_FALLBACK_RPC = "https://api.mainnet-beta.solana.com";

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime?: number | null;
  err: unknown;
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code: number; message: string };
}

export interface SolanaRpcOptions {
  apiKey?: string;
  rpcUrl?: string;
}

/**
 * The JSON-RPC calls the subscription flow needs.
 *
 * Separate from HeliusClient, which is built around batching one enrichment question across many
 * mints. This asks a handful of different questions about single transactions, and money depends
 * on the answers - notably on the commitment level, which the enrichment path has no reason to
 * care about and this one very much does.
 */
export class SolanaRpc {
  private readonly rpcUrl: string;

  constructor(options: SolanaRpcOptions = {}) {
    this.rpcUrl =
      options.rpcUrl ??
      (options.apiKey ? `https://mainnet.helius-rpc.com/?api-key=${options.apiKey}` : PUBLIC_FALLBACK_RPC);
  }

  private async call<T>(method: string, params: unknown[], timeoutMs = 15_000): Promise<T | null> {
    try {
      const body = await fetchJson<RpcEnvelope<T>>(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        timeoutMs,
      });
      if (body.error) {
        logger.warn("rpc error", { method, code: body.error.code, message: body.error.message });
        return null;
      }
      return body.result ?? null;
    } catch (err) {
      logger.warn("rpc call failed", { method, error: String(err) });
      return null;
    }
  }

  /**
   * A parsed transaction, at `finalized` commitment.
   *
   * Finalized, not confirmed, and that choice is load-bearing: a confirmed transaction can still
   * be dropped if its fork loses, and this one grants a month of paid access. Waiting the extra
   * ~13 seconds is the difference between "we credit what the chain did" and "we credit what the
   * chain probably did". A transaction that is merely confirmed reads as not-found here, which the
   * callers treat as "try again shortly" rather than as a rejection.
   *
   * Returns null for both "no such transaction" and "the RPC failed", so callers must not treat a
   * null as proof the burn did not happen - the reconciler is what turns that into an eventual
   * answer.
   */
  async getParsedTransaction(signature: string): Promise<ParsedTransaction | null> {
    return this.call<ParsedTransaction>("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
    ]);
  }

  /**
   * Signatures mentioning an address, newest first.
   *
   * Burn instructions take the mint as an account, so every burn of a token appears in this list
   * for that mint - which is what lets the reconciler find burns from wallets it has never seen.
   */
  async getSignaturesForAddress(
    address: string,
    options: { until?: string; before?: string; limit?: number } = {},
  ): Promise<SignatureInfo[] | null> {
    return this.call<SignatureInfo[]>("getSignaturesForAddress", [
      address,
      {
        commitment: "finalized",
        limit: options.limit ?? 1000,
        ...(options.until ? { until: options.until } : {}),
        ...(options.before ? { before: options.before } : {}),
      },
    ]);
  }

  /** A recent blockhash for a transaction the browser is about to sign. */
  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number } | null> {
    const result = await this.call<{ value?: { blockhash: string; lastValidBlockHeight: number } }>(
      "getLatestBlockhash",
      [{ commitment: "confirmed" }],
    );
    return result?.value ?? null;
  }

  /**
   * Relay an already-signed transaction.
   *
   * Sent from the server rather than the browser so that the signature is known here the instant
   * it exists. If the user's tab dies one millisecond later, the burn is still recoverable, because
   * we recorded the signature before we ever told the client about it.
   *
   * Errors are surfaced rather than swallowed: this is the one call whose failure means the burn
   * did NOT happen, and the frontend needs to say so rather than leave someone wondering.
   */
  async sendRawTransaction(base64Tx: string): Promise<{ signature: string } | { error: string }> {
    try {
      const body = await fetchJson<RpcEnvelope<string>>(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendTransaction",
          // preflightCommitment confirmed: reject an obviously-doomed transaction before it costs
          // the user a fee, without waiting for finality to do it.
          params: [base64Tx, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 }],
        }),
        timeoutMs: 20_000,
        // Not retried: a resend of a transaction that actually landed is wasted work at best, and
        // this call is not idempotent from the user's point of view.
        retries: 0,
      });
      if (body.error) return { error: body.error.message };
      if (!body.result) return { error: "RPC returned no signature" };
      return { signature: body.result };
    } catch (err) {
      return { error: String(err) };
    }
  }
}
