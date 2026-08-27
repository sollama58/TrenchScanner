import { fetchJson, HttpError } from "../datasources/httpClient.js";
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

  /**
   * Set the first time a batched request comes back as a client error, after which every fetch
   * goes one at a time for the rest of the process's life.
   *
   * Not every RPC speaks JSON-RPC batching - solana-rpc.publicnode.com answers a batch with a
   * flat HTTP 400 - and without this latch, pointing SOLANA_RPC_URL at such an endpoint would
   * make the reconciler fail every single fetch, credit nobody, and say nothing about why. A
   * paywall that silently stops crediting people who paid is the worst failure this system has,
   * so it degrades to slower-but-working rather than fast-but-broken.
   *
   * Deliberately not latched on 429: rate limiting is transient and says nothing about whether
   * batching is supported. Latching there would permanently downgrade a perfectly good endpoint
   * because of one busy moment.
   */
  private batchUnsupported = false;

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
   * Several parsed transactions in one round trip.
   *
   * JSON-RPC batching, because the reconciler's cold start has to look at every transaction that
   * mentions the mint in its window - measured at ~53/day for this token, so ~1,600 for a 30-day
   * first run. As individual POSTs that is enough to get rate-limited off a public RPC and turn
   * the first pass into a stuttering retry loop; batched a hundred at a time it is sixteen calls.
   *
   * Responses are matched by id, never by position: the JSON-RPC spec explicitly allows a batch to
   * come back in any order, and lining them up by index would silently attribute one transaction's
   * burn to another signature. A signature missing from the result maps to null, which callers
   * must treat as "could not fetch", not as "not a burn".
   */
  async getParsedTransactions(signatures: string[]): Promise<Map<string, ParsedTransaction | null>> {
    const out = new Map<string, ParsedTransaction | null>();
    if (signatures.length === 0) return out;
    if (this.batchUnsupported) return this.fetchSequentially(signatures);

    const body = signatures.map((signature, index) => ({
      jsonrpc: "2.0",
      id: String(index),
      method: "getTransaction",
      params: [
        signature,
        { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
      ],
    }));

    try {
      const responses = await fetchJson<(RpcEnvelope<ParsedTransaction> & { id?: string })[]>(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 30_000,
      });
      if (!Array.isArray(responses)) {
        for (const sig of signatures) out.set(sig, null);
        return out;
      }
      for (const response of responses) {
        const index = Number(response.id);
        const signature = signatures[index];
        if (signature === undefined) continue;
        out.set(signature, response.error ? null : (response.result ?? null));
      }
    } catch (err) {
      // A 4xx that isn't rate limiting means this endpoint doesn't do batching. Latch it and
      // immediately serve this same call the slow way, so the caller never sees the difference.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        logger.warn("endpoint rejected a JSON-RPC batch - falling back to one call at a time", {
          status: err.status,
        });
        this.batchUnsupported = true;
        return this.fetchSequentially(signatures);
      }
      logger.warn("batched transaction fetch failed", { count: signatures.length, error: String(err) });
    }

    // Anything the RPC didn't answer for is explicitly unknown rather than absent, so a caller
    // reading the map can't mistake a dropped response for a transaction that isn't a burn.
    for (const sig of signatures) if (!out.has(sig)) out.set(sig, null);
    return out;
  }

  /** The un-batched path, for endpoints that don't support batching. */
  private async fetchSequentially(signatures: string[]): Promise<Map<string, ParsedTransaction | null>> {
    const out = new Map<string, ParsedTransaction | null>();
    for (const signature of signatures) {
      out.set(signature, await this.getParsedTransaction(signature));
    }
    return out;
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
