import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { forEachWithConcurrency } from "../concurrency.js";
import { mayhemStateAddress } from "../solana.js";

const logger = createLogger("helius");

/**
 * Thin Solana JSON-RPC client. Uses Helius's RPC endpoint when an API key is
 * configured (recommended for production - higher rate limits, reliability,
 * and access to Helius-only methods like getTransactionsForAddress below),
 * and transparently falls back to a public RPC endpoint otherwise so local
 * dev works without signing up for anything.
 *
 * This exists as a fallback/secondary source alongside RugCheckClient: if
 * RugCheck is unavailable or hasn't indexed a very new mint yet, we can still
 * get mint/freeze authority status directly from chain.
 *
 * Every lookup here is batched: Solana's JSON-RPC accepts an array of calls in
 * a single HTTP POST and returns an array of responses (verified live against
 * both the public endpoint and Helius). One round trip for 50 addresses beats
 * 50 round trips, which is what the per-address concurrency pool used to do.
 */

interface RpcCall {
  /** Echoed back on the matching response - we use the address itself, since a batch is deduped. */
  id: string;
  method: string;
  params: unknown[];
}

interface RpcResponse<T> {
  id?: string;
  result?: T;
  error?: { code: number; message: string };
}

interface MintAccountValue {
  data?: { parsed?: { info?: { mintAuthority: string | null; freezeAuthority: string | null } } };
}

/** getSignaturesForAddress - the standard Solana RPC method, newest-first, available everywhere. */
type SignaturesResult = { signature: string; blockTime: number | null }[];

/** getTransactionsForAddress - Helius-only, supports sortOrder so the FIRST row is the earliest. */
interface TransactionsForAddressResult {
  data?: { signature?: string; blockTime: number | null }[];
  paginationToken?: string | null;
}

/**
 * A wallet's earliest known activity. The three cases are deliberately distinct because callers
 * cache this: "indeterminate" is a real, final answer worth remembering, while "failed" means we
 * never actually got an answer and must retry later rather than caching a wrong one.
 */
export type EarliestActivityResult =
  { status: "found"; earliestActivityAt: Date } | { status: "indeterminate" } | { status: "failed" };

export type MintAuthorityResult =
  { status: "found"; mintAuthorityActive: boolean; freezeAuthorityActive: boolean } | { status: "failed" };

/** Whether a mint was launched in Pump.fun's Mayhem Mode. "failed" is kept distinct from a
 *  definitive false for the same reason as EarliestActivityResult: the rug screen treats an
 *  unverified answer as a rejection, which is only correct if we can tell the two apart. */
export type MayhemModeResult = { status: "found"; isMayhemMode: boolean } | { status: "failed" };

export interface HeliusClientOptions {
  apiKey?: string;
  /** Overrides the derived RPC URL entirely - mainly for tests. */
  rpcUrl?: string;
}

const PUBLIC_FALLBACK_RPC = "https://solana-rpc.publicnode.com";

/** How many JSON-RPC calls to put in one HTTP POST. Conservative enough that no provider rejects
 *  the payload, large enough that a full cycle's wallet lookups collapse into a handful of trips. */
const RPC_BATCH_SIZE = 50;
/** How many of those batched POSTs to have in flight at once. */
const BATCH_CONCURRENCY = 3;

/** JSON-RPC's standard "Method not found" - what a non-Helius endpoint returns for a Helius-only method. */
const RPC_METHOD_NOT_FOUND = -32601;

/** getSignaturesForAddress caps at 1000 per page; hitting exactly that means there's older history
 *  we'd have to paginate for, so the true earliest is unknowable in one call. */
const SIGNATURES_PAGE_LIMIT = 1000;

export class HeliusClient {
  private readonly rpcUrl: string;
  readonly usingHelius: boolean;

  /**
   * Set once if getTransactionsForAddress comes back "method not found" - true for any non-Helius
   * endpoint, and for a Helius plan tier that doesn't include it. Latches so we stop paying a
   * wasted round trip per batch to rediscover the same thing, and fall straight to
   * getSignaturesForAddress for the rest of the process's life.
   */
  private gtfaUnavailable = false;

  constructor(options: HeliusClientOptions = {}) {
    if (options.rpcUrl) {
      this.rpcUrl = options.rpcUrl;
      this.usingHelius = options.rpcUrl.includes("helius");
    } else if (options.apiKey) {
      this.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${options.apiKey}`;
      this.usingHelius = true;
    } else {
      this.rpcUrl = PUBLIC_FALLBACK_RPC;
      this.usingHelius = false;
    }
    // Only Helius serves getTransactionsForAddress - don't even try it elsewhere.
    this.gtfaUnavailable = !this.usingHelius;
  }

  /**
   * Sends one JSON-RPC batch as a single POST and returns responses keyed by call id. Batch
   * responses may come back in any order per the JSON-RPC spec, so they're matched by id, never
   * by position. An empty map means the whole request failed - callers treat that as "no answer
   * for any of these", not "no data for any of these".
   */
  private async sendBatch<T>(calls: RpcCall[], timeoutMs: number): Promise<Map<string, RpcResponse<T>>> {
    const byId = new Map<string, RpcResponse<T>>();
    if (calls.length === 0) return byId;

    try {
      const body = calls.map((c) => ({ jsonrpc: "2.0", id: c.id, method: c.method, params: c.params }));
      const responses = await fetchJson<RpcResponse<T>[]>(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs,
        retries: 1,
      });

      // A malformed batch can come back as a single error object rather than an array.
      if (!Array.isArray(responses)) {
        logger.warn("rpc batch returned a non-array response", { calls: calls.length });
        return byId;
      }
      for (const res of responses) {
        if (typeof res?.id === "string") byId.set(res.id, res);
      }
    } catch (err) {
      logger.warn("rpc batch request failed", { calls: calls.length, error: String(err) });
    }
    return byId;
  }

  /** Splits into RPC_BATCH_SIZE chunks and runs them with bounded concurrency, merging the results. */
  private async sendBatched<T>(calls: RpcCall[], timeoutMs: number): Promise<Map<string, RpcResponse<T>>> {
    const chunks: RpcCall[][] = [];
    for (let i = 0; i < calls.length; i += RPC_BATCH_SIZE) {
      chunks.push(calls.slice(i, i + RPC_BATCH_SIZE));
    }

    const merged = new Map<string, RpcResponse<T>>();
    await forEachWithConcurrency(chunks, BATCH_CONCURRENCY, async (chunk) => {
      const result = await this.sendBatch<T>(chunk, timeoutMs);
      for (const [id, res] of result) merged.set(id, res);
    });
    return merged;
  }

  /**
   * Reads mint/freeze authority straight from the mint accounts (jsonParsed), batched. A mint the
   * RPC doesn't recognise at all comes back as "failed" rather than a bogus all-clear - callers
   * must not treat a missing answer as "authorities are revoked".
   */
  async getMintAuthorityStatusBatch(mintAddresses: string[]): Promise<Map<string, MintAuthorityResult>> {
    const unique = [...new Set(mintAddresses)];
    const out = new Map<string, MintAuthorityResult>();
    if (unique.length === 0) return out;

    const calls: RpcCall[] = unique.map((mint) => ({
      id: mint,
      method: "getAccountInfo",
      params: [mint, { encoding: "jsonParsed" }],
    }));
    const responses = await this.sendBatched<{ value?: MintAccountValue | null }>(calls, 10_000);

    for (const mint of unique) {
      const res = responses.get(mint);
      const info = res?.result?.value?.data?.parsed?.info;
      if (!res || res.error || !info) {
        if (res?.error) logger.warn("rpc error on getAccountInfo", { mint, error: res.error });
        out.set(mint, { status: "failed" });
        continue;
      }
      out.set(mint, {
        status: "found",
        mintAuthorityActive: Boolean(info.mintAuthority),
        freezeAuthorityActive: Boolean(info.freezeAuthority),
      });
    }
    return out;
  }

  /**
   * Earliest-ever activity timestamp per wallet address, batched.
   *
   * On Helius this uses getTransactionsForAddress with `sortOrder: "asc"` and `limit: 1`, so the
   * single row we get back IS the address's first-ever transaction - exact, tiny payload, and
   * free of the blind spot the fallback below has. Everywhere else (and on a Helius plan without
   * that method) it falls back to getSignaturesForAddress, which only returns the newest 1000 and
   * therefore can't see past that: an address with more history than one page reports
   * "indeterminate" rather than a confidently wrong timestamp.
   */
  async getEarliestActivityBatch(addresses: string[]): Promise<Map<string, EarliestActivityResult>> {
    const unique = [...new Set(addresses)];
    const out = new Map<string, EarliestActivityResult>();
    if (unique.length === 0) return out;

    if (!this.gtfaUnavailable) {
      const viaGtfa = await this.earliestViaGetTransactionsForAddress(unique);
      // A latched gtfaUnavailable here means the method isn't served at all - fall through and
      // redo the whole batch the standard way rather than reporting everything as failed.
      if (!this.gtfaUnavailable) return viaGtfa;
      logger.info("getTransactionsForAddress unavailable, falling back to getSignaturesForAddress");
    }

    const calls: RpcCall[] = unique.map((address) => ({
      id: address,
      method: "getSignaturesForAddress",
      params: [address, { limit: SIGNATURES_PAGE_LIMIT }],
    }));
    const responses = await this.sendBatched<SignaturesResult>(calls, 15_000);

    for (const address of unique) {
      const res = responses.get(address);
      if (!res || res.error) {
        if (res?.error) logger.warn("rpc error on getSignaturesForAddress", { address, error: res.error });
        out.set(address, { status: "failed" });
        continue;
      }
      const sigs = res.result;
      // No signatures at all, or a full page (older history exists beyond it) - both are real
      // answers of "can't pin down the earliest", not transport failures.
      if (!sigs || sigs.length === 0 || sigs.length >= SIGNATURES_PAGE_LIMIT) {
        out.set(address, { status: "indeterminate" });
        continue;
      }
      const oldest = sigs[sigs.length - 1];
      out.set(
        address,
        oldest?.blockTime
          ? { status: "found", earliestActivityAt: new Date(oldest.blockTime * 1000) }
          : { status: "indeterminate" },
      );
    }
    return out;
  }

  /**
   * Whether each mint was launched in Pump.fun's Mayhem Mode, batched. Detected purely by whether
   * the mint's `["mayhem-state", mint]` PDA exists on chain - see mayhemStateAddress() for why
   * that is the only workable signal, and why it holds for bonding-curve and graduated tokens
   * alike. The account's contents are irrelevant, so this asks for base64 and ignores the data.
   *
   * A mint whose lookup errors out reports "failed" rather than `isMayhemMode: false` - the
   * difference matters, because the rug screen rejects unverified tokens rather than admitting
   * them (see runRugScreen).
   */
  async getMayhemModeBatch(mintAddresses: string[]): Promise<Map<string, MayhemModeResult>> {
    const unique = [...new Set(mintAddresses)];
    const out = new Map<string, MayhemModeResult>();
    if (unique.length === 0) return out;

    // PDA derivation is local hashing, but it is not free - one derivation per mint, each looping
    // over bumps until it finds an off-curve point. Done once here and kept alongside the mint so
    // the response can be mapped back without re-deriving.
    const pdaByMint = new Map(unique.map((mint) => [mint, mayhemStateAddress(mint)]));

    const calls: RpcCall[] = unique.map((mint) => ({
      id: mint,
      method: "getAccountInfo",
      params: [pdaByMint.get(mint)!, { encoding: "base64" }],
    }));
    const responses = await this.sendBatched<{ value?: unknown | null }>(calls, 10_000);

    for (const mint of unique) {
      const res = responses.get(mint);
      if (!res || res.error) {
        if (res?.error) logger.warn("rpc error checking mayhem-state", { mint, error: res.error });
        out.set(mint, { status: "failed" });
        continue;
      }
      // getAccountInfo returns a null `value` for an address nothing has ever been created at,
      // which for this PDA means the mint simply was not launched in Mayhem Mode.
      out.set(mint, { status: "found", isMayhemMode: res.result?.value != null });
    }
    return out;
  }

  /** Helius-only path for getEarliestActivityBatch. Latches gtfaUnavailable if unsupported. */
  private async earliestViaGetTransactionsForAddress(
    addresses: string[],
  ): Promise<Map<string, EarliestActivityResult>> {
    const out = new Map<string, EarliestActivityResult>();
    const calls: RpcCall[] = addresses.map((address) => ({
      id: address,
      method: "getTransactionsForAddress",
      params: [address, { sortOrder: "asc", limit: 1, transactionDetails: "signatures" }],
    }));
    const responses = await this.sendBatched<TransactionsForAddressResult>(calls, 15_000);

    for (const address of addresses) {
      const res = responses.get(address);
      if (res?.error?.code === RPC_METHOD_NOT_FOUND) {
        this.gtfaUnavailable = true;
        return out;
      }
      if (!res || res.error) {
        if (res?.error) logger.warn("rpc error on getTransactionsForAddress", { address, error: res.error });
        out.set(address, { status: "failed" });
        continue;
      }
      // Sorted ascending with limit 1, so this single row is the address's first-ever transaction.
      const first = res.result?.data?.[0];
      out.set(
        address,
        first?.blockTime
          ? { status: "found", earliestActivityAt: new Date(first.blockTime * 1000) }
          : { status: "indeterminate" },
      );
    }
    return out;
  }
}
