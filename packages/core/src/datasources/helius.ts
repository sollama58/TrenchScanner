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
 *
 * IMPORTANT, because it is easy to misread the line above: batching saves LATENCY and HTTP
 * overhead, not quota. Providers bill per RPC method invocation, and a batch of 50 calls is
 * still 50 billable calls. The only things that reduce spend are caching and not making the
 * call - which is why the callers in apps/worker/src/jobs cache aggressively, why the Mayhem
 * check is now gated behind the free screen conditions, and why callCounts below exists: on a
 * fixed plan tier, method-invocation count is the number that matters, so it is measured.
 */

interface RpcCall {
  /** Echoed back on the matching response - we use the address itself, since a batch is deduped. */
  id: string;
  method: string;
  params: unknown[];
}

interface RpcResponse<T> {
  /** Echoed back as sent; typed loosely because a provider may normalize it - see sendBatch. */
  id?: string | number;
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
 * A wallet's earliest known activity. The cases are deliberately distinct because callers cache
 * this: "indeterminate" is a real, final answer worth remembering, while "failed" means we never
 * actually got an answer and must retry later rather than caching a wrong one.
 *
 * "older-than" is the middle ground the page-limited fallback produces: the wallet has more
 * history than one page, so the exact first transaction is out of reach, but everything on that
 * page is already known - so `boundAt` (the oldest signature seen) is a proven UPPER BOUND on
 * the true earliest activity. For the only question this feeds - "was this wallet funded
 * recently?" - a bound that already sits outside the freshness window answers it completely,
 * and keeps answering it as the window slides forward.
 */
export type EarliestActivityResult =
  | { status: "found"; earliestActivityAt: Date }
  | { status: "older-than"; boundAt: Date }
  | { status: "indeterminate" }
  | { status: "failed" };

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
  /**
   * Whether that URL is a Helius endpoint, when it can't be told from the URL itself - a proxy
   * or a vanity domain in front of Helius would otherwise silently lose the Helius-only path.
   */
  isHelius?: boolean;
}

const PUBLIC_FALLBACK_RPC = "https://solana-rpc.publicnode.com";

/** How many JSON-RPC calls to put in one HTTP POST. Conservative enough that no provider rejects
 *  the payload, large enough that a full cycle's wallet lookups collapse into a handful of trips. */
const RPC_BATCH_SIZE = 50;
/** How many of those batched POSTs to have in flight at once. */
const BATCH_CONCURRENCY = 3;

/** JSON-RPC's standard "Method not found" - what a non-Helius endpoint returns for a Helius-only method. */
const RPC_METHOD_NOT_FOUND = -32601;

/**
 * Page size for the getSignaturesForAddress fallback. The method allows 1000, and asking for
 * 1000 is what this used to do - but the answer being extracted is only ever "is this wallet's
 * first transaction recent?", and a signature costs ~120 bytes on the wire, so a full page ran
 * ~120KB per wallet and a 50-wallet batch approached 6MB of response for two fields.
 *
 * 200 keeps the exact answer for every wallet this check actually cares about (a wallet funded
 * within the last day has a short history by definition) at a fifth of the payload, and a
 * fuller page still yields a usable upper bound rather than a shrug - see EarliestActivityResult
 * and the "older-than" case. The residual blind spot is a wallet with 200+ transactions inside
 * the freshness window, which was equally unresolvable at 1000 for a busier wallet.
 */
const SIGNATURES_PAGE_LIMIT = 200;

/**
 * How many consecutive rounds where the Helius-only path returns NOTHING usable before we stop
 * trying it. One bad round is an outage; several in a row is a method this endpoint does not
 * serve. Deliberately not "latch on the first failure": a total Helius outage would otherwise
 * permanently downgrade a healthy deployment to the weaker fallback until the process restarts.
 */
const GTFA_FAILURE_LATCH_ROUNDS = 3;

/**
 * The mints that do NOT count as "other holdings": wrapped SOL and the two dollar stablecoins.
 * A wallet holding only these is holding cash and its own gas - it tells us nothing about
 * whether the owner actually trades this market, which is the whole question.
 *
 * Native (unwrapped) SOL needs no entry here: it lives in the account's lamports, not in a token
 * account, so it never appears in a fungible-asset listing in the first place.
 */
export const CASH_EQUIVALENT_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

/**
 * How many searchAssets calls to have in flight at once. DAS carries its OWN rate limit,
 * separate from and far tighter than the standard RPC one (10 req/s against 50 on the tier this
 * runs on), so this is deliberately below the batch concurrency used elsewhere in this client:
 * at a few hundred milliseconds per call, three in flight sits under that ceiling with room for
 * the occasional slow response.
 */
const DAS_CONCURRENCY = 3;

/** searchAssets page size. 1000 is the documented maximum; see getOtherHoldingsUsdBatch. */
const DAS_PAGE_LIMIT = 1000;

/** Consecutive barren rounds before searchAssets is written off - same reasoning as the GTFA latch. */
const DAS_FAILURE_LATCH_ROUNDS = 3;

/** One item of a searchAssets fungible-token response. */
interface DasFungibleItem {
  id?: string;
  token_info?: {
    balance?: number;
    decimals?: number;
    price_info?: { total_price?: number; price_per_token?: number };
  };
}

/**
 * The USD value a wallet holds in tokens that are neither cash nor gas. Cases are distinct for
 * the same reason EarliestActivityResult's are: only a real answer may be cached.
 *
 *  - "found": the wallet was listed successfully. `otherHoldingsUsd` is a FLOOR, not an exact
 *    net worth - holdings the indexer has no price for contribute nothing (see the note in
 *    getOtherHoldingsUsdBatch), so the number can only understate.
 *  - "unsupported": this endpoint doesn't serve DAS at all (the public fallback, notably).
 *  - "failed": transport error, rate limit, or RPC error - no answer, try again later.
 */
export type WalletHoldingsResult =
  | {
      status: "found";
      /** Non-cash, non-gas holdings. Still INCLUDES any mint of interest - see perMintUsd. */
      otherHoldingsUsd: number;
      /**
       * What this wallet holds of each mint the caller named as "of interest", in USD.
       *
       * Every requested mint gets an entry, zero included, so a reader can tell "we checked and
       * the wallet holds none of it" from "we never asked about that mint" - which is what makes
       * a cached row safe to reuse for one candidate and not another.
       *
       * This exists because the empty-wallet signal asks whether a top-10 holder owns anything
       * BESIDES the launch it is holding, and a top-10 holder owns that launch by definition. The
       * caller subtracts the relevant mint; the total is kept whole so one cached reading serves
       * every candidate the wallet holds.
       */
      perMintUsd: Record<string, number>;
    }
  | { status: "unsupported" }
  | { status: "failed" };

/**
 * How many non-cash holdings a batch must have seen before "not one of them had a price" is
 * treated as a broken pipe rather than a genuinely worthless set of wallets. Low, because the
 * batch spans many unrelated wallets - but not 1, so a single shell wallet holding one unpriced
 * memecoin still reports honestly as $0.
 */
const MIN_ITEMS_FOR_PRICE_SANITY = 15;

/**
 * The USD value of one holding. Prefers the indexer's own total_price and falls back to
 * balance x price_per_token, so a response that carries a unit price but no precomputed total
 * still values correctly. Returns null when the asset simply has no price - an illiquid
 * memecoin the indexer doesn't quote - which the caller counts as zero.
 */
function itemPriceUsd(item: DasFungibleItem): number | null {
  const info = item.token_info;
  const total = info?.price_info?.total_price;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;

  const unit = info?.price_info?.price_per_token;
  const balance = info?.balance;
  const decimals = info?.decimals;
  if (
    typeof unit === "number" &&
    Number.isFinite(unit) &&
    unit > 0 &&
    typeof balance === "number" &&
    Number.isFinite(balance) &&
    balance > 0
  ) {
    const whole = typeof decimals === "number" && decimals > 0 ? balance / 10 ** decimals : balance;
    const value = whole * unit;
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

export class HeliusClient {
  private readonly rpcUrl: string;
  readonly usingHelius: boolean;

  /**
   * Set once getTransactionsForAddress is established as unusable - true for any non-Helius
   * endpoint, and for a Helius plan tier that doesn't serve it. Latches so we stop paying a
   * wasted round trip per batch to rediscover the same thing, and fall straight to
   * getSignaturesForAddress for the rest of the process's life.
   */
  private gtfaUnavailable = false;
  /** Consecutive rounds the Helius-only path produced nothing usable - see GTFA_FAILURE_LATCH_ROUNDS. */
  private gtfaBarrenRounds = 0;
  /**
   * Set once searchAssets is established as unusable - true for any non-Helius endpoint, and for
   * a plan tier that doesn't serve DAS. Latches for the same reason gtfaUnavailable does.
   */
  private dasUnavailable = false;
  /** Consecutive rounds searchAssets produced nothing usable - see DAS_FAILURE_LATCH_ROUNDS. */
  private dasBarrenRounds = 0;
  /** RPC method invocations issued since the last takeCallStats() - the number a plan bills on. */
  private readonly callCounts = new Map<string, number>();

  constructor(options: HeliusClientOptions = {}) {
    if (options.rpcUrl) {
      this.rpcUrl = options.rpcUrl;
      this.usingHelius = options.isHelius ?? options.rpcUrl.includes("helius");
    } else if (options.apiKey) {
      this.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${options.apiKey}`;
      this.usingHelius = true;
    } else {
      this.rpcUrl = PUBLIC_FALLBACK_RPC;
      this.usingHelius = false;
    }
    // Only Helius serves getTransactionsForAddress - don't even try it elsewhere.
    this.gtfaUnavailable = !this.usingHelius;
    // Same for the DAS API, which is a Helius extension rather than standard Solana RPC.
    this.dasUnavailable = !this.usingHelius;
  }

  /**
   * RPC calls issued per method since the last read, then reset. Batching hides the real number
   * behind a much smaller count of HTTP requests, so on a metered plan this is the figure worth
   * logging each cycle - see the note at the top of this file.
   */
  takeCallStats(): Record<string, number> {
    const stats = Object.fromEntries(this.callCounts);
    this.callCounts.clear();
    return stats;
  }

  /** Which method is currently answering earliest-activity lookups, for health/diagnostics. */
  get earliestActivityMethod(): "getTransactionsForAddress" | "getSignaturesForAddress" {
    return this.gtfaUnavailable ? "getSignaturesForAddress" : "getTransactionsForAddress";
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

    // Counted before the request, not after: a batch that fails in transit still consumed the
    // attempt, and undercounting spend on exactly the unhealthy path would be the wrong bias.
    for (const call of calls) {
      this.callCounts.set(call.method, (this.callCounts.get(call.method) ?? 0) + 1);
    }

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
      // Ids are echoed back as sent, but coerced rather than type-checked: a provider that
      // normalizes them (to a number, say) would otherwise drop every response in the batch on
      // the floor and report the whole thing as failed.
      for (const res of responses) {
        if (res?.id !== undefined && res.id !== null) byId.set(String(res.id), res);
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
      // null means "this round produced nothing usable" - fall through and redo the batch the
      // standard way rather than reporting every address as failed. That distinction is the
      // whole point: the previous version only fell through on an explicit -32601 JSON-RPC
      // error, so an endpoint that rejects an unknown method at the HTTP level instead (a 400,
      // say) returned an all-failed map forever, never reaching this fallback and re-paying the
      // wasted batch every cycle, while looking like a transient outage.
      const viaGtfa = await this.earliestViaGetTransactionsForAddress(unique);
      if (viaGtfa) return viaGtfa;
      logger.info("getTransactionsForAddress unusable this round, falling back", {
        addresses: unique.length,
        barrenRounds: this.gtfaBarrenRounds,
        latched: this.gtfaUnavailable,
      });
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
      if (!sigs || sigs.length === 0) {
        out.set(address, { status: "indeterminate" });
        continue;
      }
      // Newest-first, so the last entry is the oldest this page reaches back to.
      const oldest = sigs[sigs.length - 1];
      if (!oldest?.blockTime) {
        out.set(address, { status: "indeterminate" });
        continue;
      }
      const oldestAt = new Date(oldest.blockTime * 1000);
      // A full page means older history exists beyond it, so this is a bound rather than the
      // true first transaction; a partial page IS the wallet's whole history.
      out.set(
        address,
        sigs.length >= SIGNATURES_PAGE_LIMIT
          ? { status: "older-than", boundAt: oldestAt }
          : { status: "found", earliestActivityAt: oldestAt },
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

  /**
   * Helius-only path for getEarliestActivityBatch.
   *
   * Returns null to mean "this round produced nothing usable, use the standard method instead",
   * which covers both an explicit "method not found" (latches immediately - that answer will
   * never change) and a round where every single address came back empty or failed. The latter
   * is ambiguous - an unsupported method rejected at the HTTP level looks exactly like a total
   * outage - so it only latches after GTFA_FAILURE_LATCH_ROUNDS consecutive barren rounds,
   * which an outage recovers from and an unsupported method does not.
   */
  private async earliestViaGetTransactionsForAddress(
    addresses: string[],
  ): Promise<Map<string, EarliestActivityResult> | null> {
    const out = new Map<string, EarliestActivityResult>();
    const calls: RpcCall[] = addresses.map((address) => ({
      id: address,
      method: "getTransactionsForAddress",
      params: [address, { sortOrder: "asc", limit: 1, transactionDetails: "signatures" }],
    }));
    const responses = await this.sendBatched<TransactionsForAddressResult>(calls, 15_000);

    let usable = 0;
    for (const address of addresses) {
      const res = responses.get(address);
      if (res?.error?.code === RPC_METHOD_NOT_FOUND) {
        this.gtfaUnavailable = true;
        logger.info("getTransactionsForAddress not served by this endpoint - using signatures path");
        return null;
      }
      if (!res || res.error) {
        if (res?.error) logger.warn("rpc error on getTransactionsForAddress", { address, error: res.error });
        out.set(address, { status: "failed" });
        continue;
      }
      usable += 1;
      // Sorted ascending with limit 1, so this single row is the address's first-ever transaction.
      const first = res.result?.data?.[0];
      out.set(
        address,
        first?.blockTime
          ? { status: "found", earliestActivityAt: new Date(first.blockTime * 1000) }
          : { status: "indeterminate" },
      );
    }

    if (usable === 0 && addresses.length > 0) {
      this.gtfaBarrenRounds += 1;
      if (this.gtfaBarrenRounds >= GTFA_FAILURE_LATCH_ROUNDS) {
        this.gtfaUnavailable = true;
        logger.warn("getTransactionsForAddress barren for too many rounds - using signatures path", {
          rounds: this.gtfaBarrenRounds,
        });
      }
      return null;
    }

    this.gtfaBarrenRounds = 0;
    return out;
  }

  /** Whether DAS-backed holdings lookups are currently believed usable, for health/diagnostics. */
  get holdingsLookupAvailable(): boolean {
    return !this.dasUnavailable;
  }

  /**
   * Sends ONE JSON-RPC call as its own POST. DAS methods take a single object parameter rather
   * than the positional array standard RPC uses, and array-form batching is not part of their
   * documented contract - so these go one request at a time rather than riding sendBatched.
   */
  private async sendSingle<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<RpcResponse<T> | null> {
    this.callCounts.set(method, (this.callCounts.get(method) ?? 0) + 1);
    try {
      return await fetchJson<RpcResponse<T>>(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
        timeoutMs,
        retries: 1,
      });
    } catch (err) {
      logger.warn("rpc single request failed", { method, error: String(err) });
      return null;
    }
  }

  /**
   * The USD value each wallet holds in tokens that are neither cash nor gas - the "is this a real
   * trader or a freshly-funded shell?" signal behind the empty-top-10-wallet filter.
   *
   * Uses the DAS searchAssets method, which returns a wallet's fungible holdings WITH per-asset
   * USD valuations in a single call. The alternative, getTokenAccountsByOwner, returns balances
   * but no prices, which would leave us pricing every distinct mint separately - far more calls,
   * and a much heavier response (measured at ~535 bytes per token account, and wallets with
   * thousands of accounts exist).
   *
   * The returned figure is a FLOOR. Assets the indexer carries no price for contribute zero,
   * which is the conservative direction for this signal: an unpriced bag reads as "no holdings",
   * so the filter errs toward calling a wallet empty rather than vouching for one it can't
   * value. Illiquid brand-new memecoins are exactly the assets most likely to be unpriced, so
   * this is a real effect, not a corner case - and it is why the threshold is a floor test
   * ("holds at least $X of something") rather than an estimate of anyone's net worth.
   */
  async getOtherHoldingsUsdBatch(
    addresses: string[],
    mintsOfInterest: Iterable<string> = [],
  ): Promise<Map<string, WalletHoldingsResult>> {
    const unique = [...new Set(addresses)];
    const interesting = new Set(mintsOfInterest);
    const out = new Map<string, WalletHoldingsResult>();
    if (unique.length === 0) return out;

    if (this.dasUnavailable) {
      for (const address of unique) out.set(address, { status: "unsupported" });
      return out;
    }

    let methodMissing = false;
    let usable = 0;
    // Batch-wide price coverage, for the guard below.
    let itemsSeen = 0;
    let pricedItems = 0;

    await forEachWithConcurrency(unique, DAS_CONCURRENCY, async (address) => {
      const res = await this.sendSingle<{ items?: DasFungibleItem[] }>(
        "searchAssets",
        {
          ownerAddress: address,
          tokenType: "fungible",
          page: 1,
          limit: DAS_PAGE_LIMIT,
          // params.options, NOT displayOptions - that spelling belongs to getAssetsByOwner, and
          // searchAssets nests these under `options`. It is also already the default; sent
          // explicitly so the intent (never pay for dust accounts) survives a reader.
          options: { showZeroBalance: false },
        },
        15_000,
      );

      if (!res) {
        out.set(address, { status: "failed" });
        return;
      }
      if (res.error) {
        if (res.error.code === RPC_METHOD_NOT_FOUND) methodMissing = true;
        out.set(address, { status: "failed" });
        return;
      }

      // A successful call with no items is a real answer: this wallet holds nothing fungible.
      const items = res.result?.items ?? [];
      let total = 0;
      // Seeded with a zero for every requested mint, so "holds none of it" is recorded as a fact
      // rather than as a gap - see perMintUsd on WalletHoldingsResult.
      const perMintUsd: Record<string, number> = {};
      for (const mint of interesting) perMintUsd[mint] = 0;

      for (const item of items) {
        if (!item.id || CASH_EQUIVALENT_MINTS.has(item.id)) continue;
        itemsSeen += 1;
        const price = itemPriceUsd(item);
        if (price !== null) {
          pricedItems += 1;
          total += price;
          if (interesting.has(item.id)) perMintUsd[item.id] = (perMintUsd[item.id] ?? 0) + price;
        }
      }
      usable += 1;
      out.set(address, { status: "found", otherHoldingsUsd: total, perMintUsd });
    });

    // A whole batch of holdings with not one usable price is not a finding, it is a broken
    // pipe: the response shape changed under us, or the price feed is down. Left alone it would
    // be the worst kind of wrong - every wallet silently valued at $0, every top-10 list scored
    // as 100% empty, and the filter rejecting every token it is applied to, with nothing in the
    // logs to say why. So the round is discarded and retried instead of cached.
    //
    // The tradeoff is deliberate: a batch that genuinely holds only unpriced tokens gets thrown
    // away too. That costs a retry (bounded by the caller's failure backoff) and leaves the
    // signal unknown, which skips the filter - the safe direction. Across a batch drawn from
    // several different tokens' holder lists, zero priced assets anywhere is far more likely to
    // be the broken pipe than the coincidence.
    if (itemsSeen >= MIN_ITEMS_FOR_PRICE_SANITY && pricedItems === 0) {
      logger.warn("searchAssets returned no usable prices for an entire batch - discarding round", {
        wallets: unique.length,
        itemsSeen,
      });
      for (const address of unique) out.set(address, { status: "failed" });
      return out;
    }

    // Same latch discipline as the getTransactionsForAddress path: an explicit "method not found"
    // is final, while a wholly barren round is ambiguous (an outage looks identical) and only
    // counts toward the latch.
    if (methodMissing) {
      this.dasUnavailable = true;
      logger.warn("searchAssets not served by this endpoint - holdings lookups disabled");
    } else if (usable === 0) {
      this.dasBarrenRounds += 1;
      if (this.dasBarrenRounds >= DAS_FAILURE_LATCH_ROUNDS) {
        this.dasUnavailable = true;
        logger.warn("searchAssets barren for too many rounds - holdings lookups disabled", {
          rounds: this.dasBarrenRounds,
        });
      }
    } else {
      this.dasBarrenRounds = 0;
    }

    return out;
  }
}
