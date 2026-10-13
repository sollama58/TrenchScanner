import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { forEachWithConcurrency } from "../concurrency.js";
import bs58 from "bs58";
import { mayhemStateAddress } from "../solana.js";
import { parseLaunchBuyers, type LaunchBuyersReading, type RawLaunchTx } from "./launchBuyers.js";
import type { ChainTx } from "../wallets/tradeTape.js";
import { funderFromEarliestTransactions, FUNDER_TXS_WALKED } from "../wallets/linkedWallets.js";
import { holdersFromLargestAccounts, type LargestAccount, type OnChainHolders } from "./onChainHolders.js";

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
type SignaturesResult = { signature: string; blockTime: number | null; err?: unknown }[];

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
 *
 * `activeSince` and `lastActivityAt` come from the signatures page, when it was read: the first
 * transaction after the wallet's last idle stretch of WALLET_DORMANT_GAP_MS or more (its first
 * transaction ever when it has none), and its newest. A wallet bought months ago, left empty and
 * paid again an hour before a launch has an old first transaction but a fresh `activeSince` - the
 * aged-wallet farm that read 0% fresh on mdj29p8m...pump (2026-10-13). On an "older-than" page it
 * is set only when the page itself holds such a gap; otherwise the stretch reaches past the page.
 */
export type EarliestActivityResult =
  | { status: "found"; earliestActivityAt: Date; activeSince?: Date; lastActivityAt?: Date }
  | { status: "older-than"; boundAt: Date; activeSince?: Date; lastActivityAt?: Date }
  | { status: "indeterminate" }
  | { status: "failed" };

/**
 * An idle stretch at least this long ends a wallet's previous life: activity after it counts as a
 * fresh start. Real traders rarely sit a week without a single transaction and then put a top-ten
 * stake into a launch; the farm wallets on 2026-10-13 had sat empty for 10 to 290 days.
 */
export const WALLET_DORMANT_GAP_MS = 7 * 86_400_000;

/**
 * The current stretch of a newest-first list of block times (seconds): when it began (the first
 * transaction after the newest gap of WALLET_DORMANT_GAP_MS or more) and the newest transaction.
 * `activeSince` is undefined when no gap is in the list - the stretch then begins at or before
 * its oldest entry. Exported for tests.
 */
export function activityStretch(newestFirst: readonly number[]): {
  activeSince?: Date;
  lastActivityAt?: Date;
} {
  if (newestFirst.length === 0) return {};
  const gapS = WALLET_DORMANT_GAP_MS / 1000;
  const lastActivityAt = new Date(newestFirst[0]! * 1000);
  for (let i = 0; i + 1 < newestFirst.length; i++) {
    if (newestFirst[i]! - newestFirst[i + 1]! >= gapS) {
      return { activeSince: new Date(newestFirst[i]! * 1000), lastActivityAt };
    }
  }
  return { lastActivityAt };
}

/**
 * A launch's first buyers, read from the mint's earliest transactions (see launchBuyers.ts).
 * "complete" means reading again won't change the list: it reached the count asked for, or the
 * page cap ran out first (hundreds of transactions with few distinct buyers - bots looping).
 * Short of both, the token's history simply ends there for now, and a later read can add buyers.
 * "unsupported": this endpoint can't serve the read at all.
 */
export type LaunchBuyersResult =
  | ({ status: "found"; complete: boolean } & LaunchBuyersReading)
  | { status: "unsupported" }
  | { status: "failed" };

/**
 * A wallet's funder (getFundersBatch). "none": its earliest transactions show nobody else paying
 * in; "empty": no history at all (no transaction was read); "busy": more history than one
 * signatures page and no sorted lookup to reach its first transactions. `sorted`: read with the
 * 10-credit sorted lookup (a busy wallet); else `reads` is how many 1-credit getTransaction calls
 * the walk took. `revived`: the wallet sat idle WALLET_DORMANT_GAP_MS or more and began again
 * within REVIVED_FUNDING_WITHIN_MS of the read, so the answer is who paid it at that new start,
 * not at its first transaction ever. `lastActivityAt`: its newest transaction, when the page was
 * read; the answer holds until that plus WALLET_DORMANT_GAP_MS, the earliest it could revive.
 */
export type FunderResult =
  | {
      status: "found";
      funder: string;
      amountSol: number;
      fundedAt: Date | null;
      sorted?: boolean;
      reads?: number;
      revived?: boolean;
      lastActivityAt?: Date;
    }
  | { status: "none"; sorted?: boolean; reads?: number; revived?: boolean; lastActivityAt?: Date }
  | { status: "empty" }
  | { status: "busy"; lastActivityAt?: Date }
  | { status: "failed" };

/**
 * A wallet whose current stretch of activity (activityStretch) began this recently is read for
 * who paid it at that start: an aged wallet left empty and paid again before a launch, the farm on
 * mdj29p8m...pump (2026-10-13), whose wallets were re-funded within two minutes of each other by
 * different payers. Their first-ever funders, months back, say nothing about today.
 */
export const REVIVED_FUNDING_WITHIN_MS = 24 * 3_600_000;

/**
 * One wallet as the chain has it now, for the wallet modal (getWalletOverview): its SOL balance and
 * its newest page of signatures. `txCount` is exact when `complete` (the page is its whole history,
 * so `firstAt` is its first transaction); otherwise it is the page size, a floor.
 */
export type WalletOverviewResult =
  | {
      status: "found";
      balanceSol: number | null;
      txCount: number;
      complete: boolean;
      lastAt: Date | null;
      firstAt: Date | null;
    }
  | { status: "failed" };

/** A funder's newest page of signatures, for the hot-funder check (getFunderActivityBatch). */
export type FunderActivityResult = { status: "found"; fullPageSpanMs: number | null } | { status: "failed" };

export type MintAuthorityResult =
  { status: "found"; mintAuthorityActive: boolean; freezeAuthorityActive: boolean } | { status: "failed" };

/** A mint's largest holders read from the chain (see holdersFromLargestAccounts); "failed" when any read had no usable answer. */
export type LargestHoldersResult = { status: "found"; holders: OnChainHolders } | { status: "failed" };

/** Whether a mint was launched in Pump.fun's Mayhem Mode. "failed" is kept distinct from a
 *  definitive false for the same reason as EarliestActivityResult: the rug screen treats an
 *  unverified answer as a rejection, which is only correct if we can tell the two apart. */
export type MayhemModeResult =
  | { status: "found"; isMayhemMode: boolean }
  /** `mintPending`: the RPC answered but doesn't see the mint account yet (a seconds-old token). */
  | { status: "failed"; mintPending?: boolean };

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
/** getMultipleAccounts' per-call key limit. */
const GMA_MAX_KEYS = 100;
/** How many of those batched POSTs to have in flight at once. */
const BATCH_CONCURRENCY = 3;

/**
 * Transactions per getTransactionsForAddress page on the launch-buyers read. Full transactions
 * bill 10 credits per 100 returned, so a page of 100 is the most one 10-credit call can carry.
 */
const LAUNCH_TX_PAGE = 100;
/** Launch-buyer reads in flight at once, each its own request (see getLaunchBuyersBatch). */
const LAUNCH_READ_CONCURRENCY = 5;
/** Pages read before giving up on reaching the full buyer count - caps a launch at 30 credits. */
const LAUNCH_MAX_PAGES = 3;
/** Matches packages/core/src/subscription/solanaRpc.ts: v1 transactions exist on mainnet. */
const MAX_TRANSACTION_VERSION = 1;

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
/** getSignaturesForAddress's largest page - still one credit - for the funder reads. */
const FUNDER_SIGNATURES_LIMIT = 1000;

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

/**
 * The most priced holdings a reading lists in full (see WalletHoldingsResult.complete). Top-10
 * holders of a fresh launch rarely hold more than a few dozen priced tokens; the cap keeps a
 * whale's portfolio from bloating its cache row, which then just falls back to per-launch entries.
 */
export const COMPLETE_BREAKDOWN_MAX = 100;

/** searchAssets page size. 1000 is the documented maximum; see getOtherHoldingsUsdBatch. */
const DAS_PAGE_LIMIT = 1000;

/** Consecutive barren rounds before searchAssets is stood down - see the note on dasBarrenRounds. */
const DAS_FAILURE_LATCH_ROUNDS = 3;

/**
 * How long a barren latch stands searchAssets down before it is retried.
 *
 * The barren latch used to be permanent, which made a network blip indistinguishable from a plan
 * that does not serve DAS: three consecutive unreachable rounds - seconds apart, on a batch that
 * can be a single wallet - disabled holdings lookups for the entire life of the worker process.
 * Every token then reported its empty-wallet share as unknown until someone redeployed, with one
 * line in the log to say why.
 *
 * Only an explicit "method not found" is now permanent, because only that is actually a fact
 * about the endpoint. Everything else stands down for this long and then re-probes.
 */
const DAS_STANDDOWN_MS = 10 * 60_000;

/**
 * The same, for getTransactionsForAddress. Its barren latch was permanent too - and it had more
 * riding on it: the latch also switches off the launch-buyers read behind the snipers figure, so
 * three barren rounds (two can happen per scan cycle: the wallet stage and its backfill) during
 * one Helius slowdown left every token's snipers unknown until the next deploy.
 */
const GTFA_STANDDOWN_MS = 10 * 60_000;

/**
 * Hard ceiling on searchAssets pages per wallet.
 *
 * One page is 1000 fungible holdings, which is far beyond any wallet this signal cares about -
 * but stopping at exactly one page silently truncated the few that exceed it, undervaluing them
 * and so overstating how empty they look. Paging past the first is rare enough to be free and
 * removes the cliff; the cap stops a pathological account from spending an unbounded number of
 * calls.
 */
const DAS_MAX_PAGES = 5;

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
      /**
       * True when perMintUsd also lists EVERY priced holding (not only the mints of interest), so
       * a mint absent from it was worth nothing in otherHoldingsUsd. That lets a cached reading
       * answer for a launch the wallet turns up on later without a fresh 10-credit lookup. False
       * for a wallet past the page cap or holding more than COMPLETE_BREAKDOWN_MAX priced tokens,
       * whose breakdown would be partial or too big to cache.
       */
      complete: boolean;
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

/** The two SPL token programs a holding can live under. */
const TOKEN_PROGRAM_IDS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
] as const;

/** Wallets per getTokenAccountsByOwner POST - see getTokenBalancesBatch. */
const BALANCE_WALLETS_PER_POST = 5;

/**
 * Token accounts read per wallet and program on Helius's paged getTokenAccountsByOwnerV2 - the
 * first page only. An exchange or aggregator wallet holds millions (one listed 141MB unpaged on
 * 2026-10-07), and on the unpaged call those never finished: the wallet failed every time, took
 * the four wallets sharing its request down with it, and every token it was a top-10 holder of
 * never got an empty-wallet figure (nearly half of the long-lived passing tokens still missing one
 * that day). A full first page is read as a floor, flagged `truncated`, like any wallet holding
 * more mints than the valuation prices.
 */
export const TOKEN_ACCOUNTS_PAGE_LIMIT = 1000;

/** How long the unpaged balances call stands in after a round of paged calls all erred. */
const TABO_V2_STANDDOWN_MS = 30 * 60_000;

/**
 * One wallet's token balances: raw amounts by mint, zeroes dropped. `truncated` when the wallet
 * holds more token accounts than one page read. See getTokenBalancesBatch.
 */
export type TokenBalancesResult =
  { status: "found"; balances: Map<string, bigint>; truncated?: boolean } | { status: "failed" };

/** getTokenAccountsByOwner's value (an array), or V2's, which can also come wrapped with context. */
function tokenAccountsPage(result: unknown): { accounts: TokenAccountSlice[]; more: boolean } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { value?: unknown; paginationKey?: unknown };
  const inner = r.value && !Array.isArray(r.value) && typeof r.value === "object" ? r.value : null;
  const accounts = Array.isArray(r.value)
    ? (r.value as TokenAccountSlice[])
    : inner && Array.isArray((inner as { accounts?: unknown }).accounts)
      ? (inner as { accounts: TokenAccountSlice[] }).accounts
      : null;
  if (!accounts) return null;
  const key = r.paginationKey ?? (inner as { paginationKey?: unknown } | null)?.paginationKey;
  // V2 can hand back a key on the last page too (its end is an empty page), so a key only means
  // more when the page came back full.
  return {
    accounts,
    more: typeof key === "string" && key.length > 0 && accounts.length >= TOKEN_ACCOUNTS_PAGE_LIMIT,
  };
}

/** One getTokenAccountsByOwner entry under a base64 dataSlice. */
interface TokenAccountSlice {
  account?: { data?: unknown };
}

/** `[base64, "base64"]` account data to bytes, or null for any other shape. */
function decodeBase64Data(data: unknown): Buffer | null {
  if (!Array.isArray(data) || typeof data[0] !== "string") return null;
  return Buffer.from(data[0], "base64");
}

/** Mint and raw amount from a token account's first 72 bytes; null when the slice is short. */
export function parseTokenAccountSlice(entry: TokenAccountSlice): { mint: string; amount: bigint } | null {
  const bytes = decodeBase64Data(entry.account?.data);
  if (!bytes || bytes.length < 72) return null;
  return { mint: bs58.encode(bytes.subarray(0, 32)), amount: bytes.readBigUInt64LE(64) };
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
  /**
   * Set instead when getTransactionsForAddress merely stopped answering usefully - see
   * GTFA_STANDDOWN_MS. Temporary: both the earliest-activity and launch-buyers reads skip the
   * method until this passes, then try it again.
   */
  private gtfaStoodDownUntil = 0;
  /**
   * Consecutive rounds the Helius-only path was REACHED and still produced nothing usable - see
   * GTFA_FAILURE_LATCH_ROUNDS. A round nobody answered (a timeout, a 5xx on the whole batch) is
   * not counted: an unreachable endpoint says nothing about what it serves.
   */
  private gtfaBarrenRounds = 0;
  /**
   * Set once searchAssets is established as unusable - true for any non-Helius endpoint, and for
   * a plan tier that answers "method not found". Permanent, because both are facts about the
   * endpoint rather than about today's network.
   */
  private dasUnavailable = false;
  /**
   * Set instead when searchAssets merely stopped answering - an outage, a rate-limit wall, a
   * DNS hiccup. Temporary by design: see DAS_STANDDOWN_MS for why a permanent latch here was
   * the wrong shape.
   */
  private dasStoodDownUntil = 0;
  /**
   * Consecutive rounds in which searchAssets was REACHED and still yielded nothing usable.
   *
   * Rounds we never got an answer from at all no longer count. Treating an unreachable endpoint
   * as evidence that it does not serve DAS is what let three seconds of packet loss switch the
   * signal off indefinitely.
   */
  private dasBarrenRounds = 0;
  /** Set once the endpoint answers "method not found" to getTokenAccountsByOwnerV2 - permanent. */
  private taboV2Unavailable = false;
  /**
   * Set when a whole round of getTokenAccountsByOwnerV2 calls was answered with nothing but
   * errors - a plan tier that refuses it some other way, say. The unpaged method stands in until
   * then (TABO_V2_STANDDOWN_MS), so the empty-wallet check never stops on the paged one's account.
   */
  private taboV2StoodDownUntil = 0;
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

  /**
   * Whether getTransactionsForAddress is currently worth calling: not on a non-Helius endpoint or
   * a plan that answered "method not found" (permanent), and not while stood down after barren
   * rounds (expires on its own).
   */
  get gtfaUsable(): boolean {
    return !this.gtfaUnavailable && Date.now() >= this.gtfaStoodDownUntil;
  }

  /** Which method is currently answering earliest-activity lookups, for health/diagnostics. */
  get earliestActivityMethod(): "getTransactionsForAddress" | "getSignaturesForAddress" {
    return this.gtfaUsable ? "getTransactionsForAddress" : "getSignaturesForAddress";
  }

  /**
   * Sends one JSON-RPC batch as a single POST and returns responses keyed by call id. Batch
   * responses may come back in any order per the JSON-RPC spec, so they're matched by id, never
   * by position. An empty map means the whole request failed - callers treat that as "no answer
   * for any of these", not "no data for any of these".
   */
  private async sendBatch<T>(
    calls: RpcCall[],
    timeoutMs: number,
    opts: { retryOnTimeout?: boolean } = {},
  ): Promise<Map<string, RpcResponse<T>>> {
    const byId = new Map<string, RpcResponse<T>>();
    if (calls.length === 0) return byId;

    // Counted before the request, not after: a batch that fails in transit still consumed the
    // attempt, and undercounting spend on exactly the unhealthy path would be the wrong bias.
    const count = () => {
      for (const call of calls) {
        this.callCounts.set(call.method, (this.callCounts.get(call.method) ?? 0) + 1);
      }
    };
    count();

    try {
      const body = calls.map((c) => ({ jsonrpc: "2.0", id: c.id, method: c.method, params: c.params }));
      const responses = await fetchJson<RpcResponse<T>[]>(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs,
        retries: 1,
        // A retry is another billed request: counted like the first.
        onRetry: count,
        ...(opts.retryOnTimeout === false ? { retryOnTimeout: false } : {}),
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

  /**
   * Splits into RPC_BATCH_SIZE chunks (or opts.batchSize) and runs them with bounded concurrency
   * (BATCH_CONCURRENCY, or opts.concurrency), merging the results.
   */
  private async sendBatched<T>(
    calls: RpcCall[],
    timeoutMs: number,
    opts: { batchSize?: number; concurrency?: number; retryOnTimeout?: boolean } = {},
  ): Promise<Map<string, RpcResponse<T>>> {
    const size = opts.batchSize ?? RPC_BATCH_SIZE;
    const chunks: RpcCall[][] = [];
    for (let i = 0; i < calls.length; i += size) {
      chunks.push(calls.slice(i, i + size));
    }

    const merged = new Map<string, RpcResponse<T>>();
    await forEachWithConcurrency(chunks, opts.concurrency ?? BATCH_CONCURRENCY, async (chunk) => {
      const result = await this.sendBatch<T>(chunk, timeoutMs, { retryOnTimeout: opts.retryOnTimeout });
      for (const [id, res] of result) merged.set(id, res);
    });
    return merged;
  }

  /**
   * Fetches many accounts with getMultipleAccounts - one billed call per GMA_MAX_KEYS addresses,
   * where a getAccountInfo per address billed one each (batching those only saved latency, see
   * the note at the top of this file). Reads at "confirmed": the default "finalized" lags ~13s,
   * and a mint seconds old can be missing there, which the Mayhem check would otherwise read -
   * and cache for good - as "no Mayhem state account".
   *
   * Per address: the account value (null when nothing exists there), or "failed" when its chunk
   * got no usable answer.
   */
  private async getMultipleAccounts<T>(
    addresses: string[],
    config: Record<string, unknown>,
  ): Promise<Map<string, { value: T | null } | "failed">> {
    const chunks: string[][] = [];
    for (let i = 0; i < addresses.length; i += GMA_MAX_KEYS)
      chunks.push(addresses.slice(i, i + GMA_MAX_KEYS));
    const calls: RpcCall[] = chunks.map((chunk, i) => ({
      id: `gma-${i}`,
      method: "getMultipleAccounts",
      params: [chunk, { commitment: "confirmed", ...config }],
    }));
    const responses = await this.sendBatched<{ value?: (T | null)[] }>(calls, 10_000);

    const out = new Map<string, { value: T | null } | "failed">();
    chunks.forEach((chunk, i) => {
      const res = responses.get(`gma-${i}`);
      const values = res?.result?.value;
      if (!res || res.error || !Array.isArray(values) || values.length !== chunk.length) {
        if (res?.error)
          logger.warn("rpc error on getMultipleAccounts", { keys: chunk.length, error: res.error });
        for (const address of chunk) out.set(address, "failed");
        return;
      }
      chunk.forEach((address, j) => out.set(address, { value: values[j] ?? null }));
    });
    return out;
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

    const accounts = await this.getMultipleAccounts<MintAccountValue>(unique, { encoding: "jsonParsed" });
    for (const mint of unique) {
      const account = accounts.get(mint);
      const info = account && account !== "failed" ? account.value?.data?.parsed?.info : undefined;
      if (!info) {
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
   * The ten largest wallets of each mint and their share of supply, straight from the chain: the
   * backup for a mint RugCheck has no report for. Per mint, getTokenLargestAccounts (its 20
   * largest token accounts) and getTokenSupply in one batch, then one getMultipleAccounts over
   * every account found for the wallets that own them. Any read without a usable answer makes
   * that mint "failed", never a partial list read as complete.
   */
  async getLargestHoldersBatch(mintAddresses: string[]): Promise<Map<string, LargestHoldersResult>> {
    const unique = [...new Set(mintAddresses)];
    const out = new Map<string, LargestHoldersResult>();
    if (unique.length === 0) return out;

    const calls: RpcCall[] = unique.flatMap((mint) => [
      { id: `lta-${mint}`, method: "getTokenLargestAccounts", params: [mint, { commitment: "confirmed" }] },
      { id: `sup-${mint}`, method: "getTokenSupply", params: [mint, { commitment: "confirmed" }] },
    ]);
    const responses = await this.sendBatched<{ value?: unknown }>(calls, 10_000);

    const accountsByMint = new Map<string, { address: string; amount: bigint }[]>();
    const supplyByMint = new Map<string, bigint>();
    for (const mint of unique) {
      const largest = responses.get(`lta-${mint}`)?.result?.value;
      const supply = (responses.get(`sup-${mint}`)?.result?.value as { amount?: unknown } | undefined)
        ?.amount;
      if (!Array.isArray(largest) || typeof supply !== "string" || !/^\d+$/.test(supply)) {
        out.set(mint, { status: "failed" });
        continue;
      }
      const accounts: { address: string; amount: bigint }[] = [];
      for (const entry of largest as { address?: unknown; amount?: unknown }[]) {
        if (
          typeof entry?.address === "string" &&
          typeof entry.amount === "string" &&
          /^\d+$/.test(entry.amount)
        )
          accounts.push({ address: entry.address, amount: BigInt(entry.amount) });
      }
      accountsByMint.set(mint, accounts);
      supplyByMint.set(mint, BigInt(supply));
    }

    const tokenAccounts = [...new Set([...accountsByMint.values()].flat().map((a) => a.address))];
    const owners =
      tokenAccounts.length > 0
        ? await this.getMultipleAccounts<{ data?: { parsed?: { info?: { owner?: unknown } } } }>(
            tokenAccounts,
            {
              encoding: "jsonParsed",
            },
          )
        : new Map();
    for (const [mint, accounts] of accountsByMint) {
      const withOwners: LargestAccount[] = [];
      let complete = true;
      for (const a of accounts) {
        const account = owners.get(a.address);
        const owner = account && account !== "failed" ? account.value?.data?.parsed?.info?.owner : undefined;
        if (typeof owner !== "string") {
          complete = false;
          break;
        }
        withOwners.push({ owner, amount: a.amount });
      }
      const holders = complete ? holdersFromLargestAccounts(withOwners, supplyByMint.get(mint)!) : null;
      out.set(mint, holders ? { status: "found", holders } : { status: "failed" });
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
  async getEarliestActivityBatch(
    addresses: string[],
    opts: {
      /**
       * An "older-than" bound before this date is answer enough - the caller only needs to know
       * the wallet is older than that. When set, every address is first asked the cheap way
       * (getSignaturesForAddress, 1 credit) and only those it can't settle go on to
       * getTransactionsForAddress (10 credits): a wallet whose whole history fits one page, or
       * whose page already reaches back past this date, never needs it - which covers the fresh
       * sniper wallets and long-lived wallets alike; only busy wallets with a full page inside
       * the window pay for the exact answer.
       */
      boundSufficientBefore?: Date;
    } = {},
  ): Promise<Map<string, EarliestActivityResult>> {
    const unique = [...new Set(addresses)];
    if (unique.length === 0) return new Map();

    if (opts.boundSufficientBefore && this.gtfaUsable) {
      const sufficientMs = opts.boundSufficientBefore.getTime();
      const cheap = await this.earliestViaSignatures(unique);
      // Only a bound inside the window goes on to the exact method. A cheap lookup that failed
      // stays failed (the caller backs it off and asks again): escalating it sent every wallet of
      // a timed-out signatures batch to the 10-credit method on the same slow provider.
      // A page that holds an idle gap already says when the current stretch began.
      const unsettled = unique.filter((address) => {
        const r = cheap.get(address);
        return r?.status === "older-than" && r.boundAt.getTime() >= sufficientMs && !r.activeSince;
      });
      if (unsettled.length === 0) return cheap;
      const exact = await this.earliestViaGetTransactionsForAddress(unsettled);
      // An unsettled address takes the exact answer or none. Its cheap result is a bound INSIDE
      // the window, which says only "busy", and handing it on when the exact lookup failed had
      // the caller cache a recently funded busy wallet as "not fresh" for good, off one 429.
      // Failed, it is retried on a later cycle instead. The page's newest transaction rides along.
      for (const address of unsettled) {
        const r = exact?.get(address);
        const before = cheap.get(address);
        const lastActivityAt = before?.status === "older-than" ? before.lastActivityAt : undefined;
        cheap.set(address, r?.status === "found" ? { ...r, lastActivityAt } : (r ?? { status: "failed" }));
      }
      return cheap;
    }

    if (this.gtfaUsable) {
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
        latched: !this.gtfaUsable,
      });
    }

    return this.earliestViaSignatures(unique);
  }

  /**
   * getSignaturesForAddress path for getEarliestActivityBatch: one page of the newest
   * SIGNATURES_PAGE_LIMIT signatures per address. A partial page is the wallet's whole history,
   * so its oldest entry is exact; a full page only bounds it ("older-than").
   */
  private async earliestViaSignatures(addresses: string[]): Promise<Map<string, EarliestActivityResult>> {
    const out = new Map<string, EarliestActivityResult>();
    const calls: RpcCall[] = addresses.map((address) => ({
      id: address,
      method: "getSignaturesForAddress",
      params: [address, { limit: SIGNATURES_PAGE_LIMIT }],
    }));
    const responses = await this.sendBatched<SignaturesResult>(calls, 15_000);

    for (const address of addresses) {
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
      const times = sigs.map((s) => s.blockTime).filter((t): t is number => typeof t === "number");
      const stretch = activityStretch(times);
      // A full page means older history exists beyond it, so this is a bound rather than the
      // true first transaction; a partial page IS the wallet's whole history, so with no idle gap
      // in it the current stretch began at its first transaction.
      out.set(
        address,
        sigs.length >= SIGNATURES_PAGE_LIMIT
          ? { status: "older-than", boundAt: oldestAt, ...stretch }
          : {
              status: "found",
              earliestActivityAt: oldestAt,
              activeSince: stretch.activeSince ?? oldestAt,
              lastActivityAt: stretch.lastActivityAt,
            },
      );
    }
    return out;
  }

  /**
   * Who paid for each wallet: the first transaction among its oldest that paid SOL into it
   * (funderFromEarliestTransactions), for the linked-wallets reading
   * (packages/core/src/wallets/linkedWallets.ts). One 1-credit page of its newest signatures, then,
   * when that page is its whole history, its oldest transactions one at a time (1 credit each, up to
   * FUNDER_TXS_WALKED) until the funding shows: the first is often a token account someone opened
   * for it, with the SOL a transaction later. A wallet with more history than a page (an active
   * trader, a bot, a dev's long-used wallet) has its oldest transactions read with the sorted lookup
   * instead, 10 credits for all of them (user decision 2026-10-13: busy wallets count too). Every
   * answer but "failed" and "busy" is final and cached by the caller.
   */
  async getFundersBatch(
    wallets: string[],
    opts: { nowMs?: number } = {},
  ): Promise<Map<string, FunderResult>> {
    const nowMs = opts.nowMs ?? Date.now();
    const unique = [...new Set(wallets)];
    const out = new Map<string, FunderResult>();
    if (unique.length === 0) return out;
    const pages = await this.sendBatched<SignaturesResult>(
      unique.map((address) => ({
        id: address,
        method: "getSignaturesForAddress",
        params: [address, { limit: FUNDER_SIGNATURES_LIMIT }],
      })),
      15_000,
    );
    // Each wallet's oldest successful signatures, oldest first (a failed transaction moved no SOL),
    // or, for a wallet revived within REVIVED_FUNDING_WITHIN_MS, the oldest of its current stretch.
    const oldest = new Map<string, string[]>();
    const revived = new Set<string>();
    const lastActivity = new Map<string, Date>();
    const busy: string[] = [];
    for (const wallet of unique) {
      const res = pages.get(wallet);
      if (!res || res.error || !Array.isArray(res.result)) {
        out.set(wallet, { status: "failed" });
        continue;
      }
      const sigs = res.result;
      if (sigs.length === 0) {
        out.set(wallet, { status: "empty" });
        continue;
      }
      const times = sigs.map((s) => s.blockTime).filter((t): t is number => typeof t === "number");
      const stretch = activityStretch(times);
      if (stretch.lastActivityAt) lastActivity.set(wallet, stretch.lastActivityAt);
      // The stretch starts at the newest gap, which the page holds whether or not it is full: the
      // last signature at or after activeSince, newest first.
      const since = stretch.activeSince?.getTime();
      let start = -1;
      if (since !== undefined && nowMs - since <= REVIVED_FUNDING_WITHIN_MS) {
        sigs.forEach((s, i) => {
          if (typeof s.blockTime === "number" && s.blockTime * 1000 >= since) start = i;
        });
      }
      const walk =
        start >= 0 ? sigs.slice(0, start + 1) : sigs.length >= FUNDER_SIGNATURES_LIMIT ? null : sigs;
      if (!walk) {
        busy.push(wallet);
        continue;
      }
      if (start >= 0) revived.add(wallet);
      const ok = walk
        .filter((s) => s.err == null)
        .slice(-FUNDER_TXS_WALKED)
        .reverse()
        .map((s) => s.signature);
      if (ok.length === 0)
        out.set(wallet, { status: "none", reads: 0, ...this.stretchOf(wallet, revived, lastActivity) });
      else oldest.set(wallet, ok);
    }
    for (const [wallet, result] of await this.fundersOfBusyWallets(busy)) {
      out.set(
        wallet,
        result.status === "failed" ? result : { ...result, ...this.stretchOf(wallet, revived, lastActivity) },
      );
    }

    // One transaction per wallet per round, oldest first, until each wallet's walk is decided.
    const walked = new Map<string, ChainTx[]>();
    let pending = [...oldest.keys()];
    for (let round = 0; pending.length > 0; round += 1) {
      const txs = await this.sendBatched<ChainTx | null>(
        pending.map((wallet) => ({
          id: wallet,
          method: "getTransaction",
          params: [
            oldest.get(wallet)![round]!,
            // Version 1 too: asking for 0 failed every wallet whose transaction was a v1 one.
            {
              encoding: "json",
              maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION,
              commitment: "confirmed",
            },
          ],
        })),
        15_000,
      );
      const next: string[] = [];
      for (const wallet of pending) {
        const res = txs.get(wallet);
        if (!res || res.error || !res.result) {
          out.set(wallet, { status: "failed" });
          continue;
        }
        const seen = [...(walked.get(wallet) ?? []), res.result];
        walked.set(wallet, seen);
        const { found, decided } = funderFromEarliestTransactions(wallet, seen);
        if (!decided && round + 1 < oldest.get(wallet)!.length) {
          next.push(wallet);
          continue;
        }
        out.set(wallet, {
          ...funderResultOf(found, { reads: round + 1 }),
          ...this.stretchOf(wallet, revived, lastActivity),
        });
      }
      pending = next;
    }
    return out;
  }

  private stretchOf(
    wallet: string,
    revived: ReadonlySet<string>,
    lastActivity: ReadonlyMap<string, Date>,
  ): { revived?: true; lastActivityAt?: Date } {
    const at = lastActivity.get(wallet);
    return {
      ...(revived.has(wallet) ? { revived: true as const } : {}),
      ...(at ? { lastActivityAt: at } : {}),
    };
  }

  /**
   * The funder of each wallet with more history than one signatures page: its oldest transactions
   * in full, from getTransactionsForAddress sorted oldest first (10 credits each). "busy" without
   * that method (another provider, or Helius standing it down), so the caller can read it again
   * later.
   */
  private async fundersOfBusyWallets(wallets: string[]): Promise<Map<string, FunderResult>> {
    const out = new Map<string, FunderResult>();
    if (wallets.length === 0) return out;
    if (!this.gtfaUsable) {
      for (const wallet of wallets) out.set(wallet, { status: "busy" });
      return out;
    }
    const responses = await this.sendBatched<{ data?: ChainTx[] }>(
      wallets.map((address) => ({
        id: address,
        method: "getTransactionsForAddress",
        params: [
          address,
          {
            transactionDetails: "full",
            sortOrder: "asc",
            limit: FUNDER_TXS_WALKED,
            encoding: "json",
            maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION,
            filters: { status: "succeeded" },
          },
        ],
      })),
      20_000,
      // Billed whether or not the answer arrives in time, as for the launch read.
      { retryOnTimeout: false },
    );
    for (const wallet of wallets) {
      const res = responses.get(wallet);
      if (res?.error?.code === RPC_METHOD_NOT_FOUND) {
        this.gtfaUnavailable = true;
        out.set(wallet, { status: "busy" });
        continue;
      }
      if (!res || res.error || !Array.isArray(res.result?.data)) {
        out.set(wallet, { status: "failed" });
        continue;
      }
      const { found } = funderFromEarliestTransactions(wallet, res.result.data);
      out.set(wallet, funderResultOf(found, { sorted: true }));
    }
    return out;
  }

  /**
   * For each funder, how long its newest FUNDER_SIGNATURES_LIMIT signatures span, in ms - null when
   * that page is its whole history. A full page inside a day marks an exchange or service
   * (isHotFunder). One 1-credit call each.
   */
  async getFunderActivityBatch(funders: string[]): Promise<Map<string, FunderActivityResult>> {
    const unique = [...new Set(funders)];
    const out = new Map<string, FunderActivityResult>();
    if (unique.length === 0) return out;
    const pages = await this.sendBatched<SignaturesResult>(
      unique.map((address) => ({
        id: address,
        method: "getSignaturesForAddress",
        params: [address, { limit: FUNDER_SIGNATURES_LIMIT }],
      })),
      15_000,
    );
    for (const funder of unique) {
      const res = pages.get(funder);
      if (!res || res.error || !Array.isArray(res.result)) {
        out.set(funder, { status: "failed" });
        continue;
      }
      const sigs = res.result;
      const newest = sigs[0]?.blockTime;
      const oldest = sigs[sigs.length - 1]?.blockTime;
      out.set(funder, {
        status: "found",
        fullPageSpanMs:
          sigs.length >= FUNDER_SIGNATURES_LIMIT && newest && oldest ? (newest - oldest) * 1000 : null,
      });
    }
    return out;
  }

  /**
   * A wallet's SOL balance and newest page of signatures, in one POST of two 1-credit calls. For
   * the wallet modal, which reads one wallet at a time when someone opens it.
   */
  async getWalletOverview(wallet: string): Promise<WalletOverviewResult> {
    const res = await this.sendBatch<unknown>(
      [
        { id: "balance", method: "getBalance", params: [wallet, { commitment: "confirmed" }] },
        {
          id: "sigs",
          method: "getSignaturesForAddress",
          params: [wallet, { limit: FUNDER_SIGNATURES_LIMIT, commitment: "confirmed" }],
        },
      ],
      10_000,
    );
    const sigs = res.get("sigs");
    if (!sigs || sigs.error || !Array.isArray(sigs.result)) return { status: "failed" };
    const page = sigs.result as SignaturesResult;
    const balance = res.get("balance");
    const lamports = (balance?.result as { value?: unknown } | undefined)?.value;
    const at = (t: number | null | undefined) => (typeof t === "number" ? new Date(t * 1000) : null);
    const complete = page.length < FUNDER_SIGNATURES_LIMIT;
    return {
      status: "found",
      balanceSol: typeof lamports === "number" ? lamports / 1_000_000_000 : null,
      txCount: page.length,
      complete,
      lastAt: at(page[0]?.blockTime),
      firstAt: complete ? at(page[page.length - 1]?.blockTime) : null,
    };
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

    // The mint itself rides along in the same call: the Mayhem state account is created with the
    // mint, so if the mint is visible and the PDA isn't, the mint really wasn't launched in Mayhem
    // Mode - but if the mint isn't visible yet either, "no PDA" proves nothing and must not be
    // cached as a definitive false. Zero-length dataSlice: only existence matters.
    const accounts = await this.getMultipleAccounts<unknown>([...unique, ...pdaByMint.values()], {
      encoding: "base64",
      dataSlice: { offset: 0, length: 0 },
    });

    for (const mint of unique) {
      const mintAccount = accounts.get(mint);
      const pdaAccount = accounts.get(pdaByMint.get(mint)!);
      if (!mintAccount || mintAccount === "failed" || !pdaAccount || pdaAccount === "failed") {
        out.set(mint, { status: "failed" });
        continue;
      }
      if (mintAccount.value === null) {
        out.set(mint, { status: "failed", mintPending: true });
        continue;
      }
      out.set(mint, { status: "found", isMayhemMode: pdaAccount.value !== null });
    }
    return out;
  }

  /**
   * The first `maxBuyers` buyers of each mint, from its earliest transactions: one
   * getTransactionsForAddress call per mint (sortOrder asc, full transactions, failed ones
   * filtered out server-side), 10 credits for up to 100 transactions. A launch whose first page
   * holds fewer buyers than asked - a create buried under failed sniper attempts and bot noise -
   * reads a further page, up to LAUNCH_MAX_PAGES. Helius-only: elsewhere every mint reports
   * "unsupported".
   */
  async getLaunchBuyersBatch(
    mintAddresses: string[],
    maxBuyers: number,
  ): Promise<Map<string, LaunchBuyersResult>> {
    const unique = [...new Set(mintAddresses)];
    const out = new Map<string, LaunchBuyersResult>();
    if (unique.length === 0) return out;
    if (!this.gtfaUsable) {
      for (const mint of unique) out.set(mint, { status: "unsupported" });
      return out;
    }

    const txsByMint = new Map<string, RawLaunchTx[]>(unique.map((m) => [m, []]));
    const cursor = new Map<string, string | undefined>();
    let pending = unique;
    for (let page = 1; page <= LAUNCH_MAX_PAGES && pending.length > 0; page += 1) {
      const calls: RpcCall[] = pending.map((mint) => ({
        id: mint,
        method: "getTransactionsForAddress",
        params: [
          mint,
          {
            transactionDetails: "full",
            sortOrder: "asc",
            limit: LAUNCH_TX_PAGE,
            encoding: "json",
            maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION,
            filters: { status: "succeeded" },
            ...(cursor.get(mint) ? { paginationToken: cursor.get(mint) } : {}),
          },
        ],
      }));
      // One mint per POST, a few at a time: a page is up to 100 full transactions, and twenty of
      // them in one batch (#276's contender budget) is a response so large it timed out or was
      // refused whole, failing every mint in it - after that deploy almost no launch was read.
      const responses = await this.sendBatched<{ data?: RawLaunchTx[]; paginationToken?: string | null }>(
        calls,
        15_000,
        // A page of 100 full transactions that timed out was most likely served and billed
        // anyway; the same request again pays twice. The mint is re-read on a later cycle.
        { batchSize: 1, concurrency: LAUNCH_READ_CONCURRENCY, retryOnTimeout: false },
      );

      const next: string[] = [];
      for (const mint of pending) {
        const res = responses.get(mint);
        if (res?.error?.code === RPC_METHOD_NOT_FOUND) {
          this.gtfaUnavailable = true;
          logger.info("getTransactionsForAddress not served by this endpoint - launch buyers unavailable");
          out.set(mint, { status: "unsupported" });
          continue;
        }
        const txs = txsByMint.get(mint)!;
        if (!res || res.error || !Array.isArray(res.result?.data)) {
          if (res?.error) logger.warn("rpc error on launch buyers read", { mint, error: res.error });
          // A later page failing doesn't lose the pages already paid for: what they hold is the
          // reading so far, incomplete, and the retry adds to it rather than starting over.
          const partial = txs.length > 0 ? parseLaunchBuyers(mint, txs, maxBuyers) : null;
          out.set(mint, partial ? { status: "found", complete: false, ...partial } : { status: "failed" });
          continue;
        }
        txs.push(...res.result.data);
        const reading = parseLaunchBuyers(mint, txs, maxBuyers);
        if (!reading) {
          if (txs.length === 0 || txs.some((tx) => !tx || !tx.meta)) {
            // An empty history is a mint too new for the index yet - worth a retry, not an answer.
            // So is a page with an entry that carries no meta at all (not a failed transaction, an
            // unreadable one): the parser skips it, the next entry stands in as the "launch" and
            // reads as not one, and the answer below would be cached for the process lifetime.
            out.set(mint, { status: "failed" });
          } else {
            // A history that doesn't start at a launch (a mint created and minted to in separate
            // transactions, a token that didn't launch on a curve) never will: its first
            // transaction is fixed. Reported as a complete reading with no buyers - which stays
            // "unknown" downstream - so the caller caches it instead of re-paying 10-30 credits
            // for the same answer every five minutes the token spends in band.
            out.set(mint, {
              status: "found",
              complete: true,
              buyers: [],
              launchAt: null,
              supply: 0,
              devBought: 0,
              createSlot: null,
            });
          }
          continue;
        }
        const token = res.result.paginationToken ?? undefined;
        const historyEnds = res.result.data.length < LAUNCH_TX_PAGE || !token;
        if (reading.buyers.length >= maxBuyers || historyEnds || page === LAUNCH_MAX_PAGES) {
          out.set(mint, {
            status: "found",
            complete: reading.buyers.length >= maxBuyers || !historyEnds,
            ...reading,
          });
          continue;
        }
        cursor.set(mint, token);
        next.push(mint);
      }
      pending = next;
    }
    return out;
  }

  /**
   * One page of a mint's transactions, oldest first, with full details - the trade tape's read
   * (apps/worker/src/jobs/tradeTapeJob.ts). getTransactionsForAddress on the mint, failed ones
   * filtered out server-side, up to 100 a page for 10 credits, from `paginationToken` when given.
   * `untilBlockTime` (unix seconds) asks the server to stop there; the caller still filters by time,
   * so a server that ignores it costs pages, not correctness. `newest`: the newest page instead,
   * newest first (the live tape before a call, apps/worker/src/jobs/liveTape.ts). Helius-only:
   * "unsupported" elsewhere.
   */
  async getMintTransactionsPage(
    mint: string,
    opts: { paginationToken?: string; untilBlockTime?: number; newest?: boolean } = {},
  ): Promise<
    | { status: "ok"; txs: ChainTx[]; paginationToken: string | null }
    | { status: "unsupported" }
    | { status: "failed" }
  > {
    if (!this.gtfaUsable) return { status: "unsupported" };
    const responses = await this.sendBatch<{ data?: ChainTx[]; paginationToken?: string | null }>(
      [
        {
          id: mint,
          method: "getTransactionsForAddress",
          params: [
            mint,
            {
              transactionDetails: "full",
              sortOrder: opts.newest ? "desc" : "asc",
              limit: LAUNCH_TX_PAGE,
              encoding: "json",
              maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION,
              filters: {
                status: "succeeded",
                ...(opts.untilBlockTime !== undefined ? { blockTime: { lte: opts.untilBlockTime } } : {}),
              },
              ...(opts.paginationToken ? { paginationToken: opts.paginationToken } : {}),
            },
          ],
        },
      ],
      20_000,
      // A timed-out page of full transactions was most likely served and billed anyway.
      { retryOnTimeout: false },
    );
    const res = responses.get(mint);
    if (res?.error?.code === RPC_METHOD_NOT_FOUND) {
      this.gtfaUnavailable = true;
      return { status: "unsupported" };
    }
    if (!res || res.error || !Array.isArray(res.result?.data)) {
      if (res?.error) logger.warn("rpc error on mint transactions page", { mint, error: res.error });
      return { status: "failed" };
    }
    const data = res.result.data;
    const token = res.result.paginationToken ?? null;
    return { status: "ok", txs: data, paginationToken: data.length < LAUNCH_TX_PAGE ? null : token };
  }

  /**
   * Current balances (base units) of SPL token accounts, via getMultipleAccounts - one billed
   * call per 100 accounts. A closed or never-created account is 0; an account whose chunk got no
   * answer is left out, so the caller can tell "sold" from "unknown".
   */
  async getTokenAccountBalances(accounts: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(accounts)];
    const out = new Map<string, number>();
    if (unique.length === 0) return out;
    const values = await this.getMultipleAccounts<{
      data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
    }>(unique, { encoding: "jsonParsed" });
    for (const account of unique) {
      const v = values.get(account);
      if (!v || v === "failed") continue;
      if (v.value === null) {
        out.set(account, 0);
        continue;
      }
      const amount = Number(v.value.data?.parsed?.info?.tokenAmount?.amount);
      if (Number.isFinite(amount)) out.set(account, amount);
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
    // Not retried on a timeout, for the launch read's reason (10 credits an address, already billed).
    const responses = await this.sendBatched<TransactionsForAddressResult>(calls, 15_000, {
      retryOnTimeout: false,
    });

    let usable = 0;
    let answered = 0;
    for (const address of addresses) {
      const res = responses.get(address);
      if (res?.error?.code === RPC_METHOD_NOT_FOUND) {
        this.gtfaUnavailable = true;
        logger.info("getTransactionsForAddress not served by this endpoint - using signatures path");
        return null;
      }
      if (res) answered += 1;
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
      // Stood down, never switched off: a barren round looks the same from here whether the plan
      // lacks the method or Helius is having a bad minute, and only -32601 above is the former.
      // A round with no answer at all is not counted - it says nothing about the method.
      if (answered === 0) {
        logger.warn("getTransactionsForAddress unreachable this round - not counted against the latch", {
          addresses: addresses.length,
        });
      } else {
        this.gtfaBarrenRounds += 1;
        if (this.gtfaBarrenRounds >= GTFA_FAILURE_LATCH_ROUNDS) {
          this.gtfaStoodDownUntil = Date.now() + GTFA_STANDDOWN_MS;
          this.gtfaBarrenRounds = 0;
          logger.warn("getTransactionsForAddress barren for too many rounds - standing down, will retry", {
            standDownMinutes: Math.round(GTFA_STANDDOWN_MS / 60_000),
          });
        }
      }
      return null;
    }

    this.gtfaBarrenRounds = 0;
    return out;
  }

  /**
   * Every token a wallet holds, as raw amounts by mint - the cheap half of the empty-wallet check
   * (see apps/worker/src/jobs/walletValuation.ts, which prices them).
   *
   * Two getTokenAccountsByOwner calls per wallet, one per token program (Pump.fun launches now
   * mint under Token-2022, older tokens and most majors under the original program), each a
   * 1-credit standard call: a fifth of one 10-credit searchAssets. dataSlice keeps only the
   * account's first 72 bytes - the mint (0..32) and the amount (64..72), laid out the same in both
   * programs - so a wallet with thousands of token accounts stays a small response, which was the
   * reason this route was once passed over. On Helius the paged V2 method reads one page of
   * TOKEN_ACCOUNTS_PAGE_LIMIT, so a wallet with millions doesn't fail the lookup.
   *
   * Zero balances are dropped. A wallet is "failed" unless BOTH programs answered: half a list
   * would read a real trader as empty.
   */
  async getTokenBalancesBatch(addresses: string[]): Promise<Map<string, TokenBalancesResult>> {
    const unique = [...new Set(addresses)];
    const out = new Map<string, TokenBalancesResult>();
    if (unique.length === 0) return out;
    const paged = this.usingHelius && !this.taboV2Unavailable && Date.now() >= this.taboV2StoodDownUntil;
    const callsFor = (address: string): RpcCall[] =>
      TOKEN_PROGRAM_IDS.map((programId, p) => ({
        id: `tabo-${p}-${address}`,
        method: paged ? "getTokenAccountsByOwnerV2" : "getTokenAccountsByOwner",
        params: [
          address,
          { programId },
          {
            encoding: "base64",
            commitment: "confirmed",
            dataSlice: { offset: 0, length: 72 },
            ...(paged ? { limit: TOKEN_ACCOUNTS_PAGE_LIMIT } : {}),
          },
        ],
      }));
    // A few wallets per POST rather than RPC_BATCH_SIZE calls: an active trader's list runs to
    // thousands of accounts (~1MB measured for 2,800), so a full batch of them could be tens of
    // megabytes in one response. Paged, a wallet is at most one page per program.
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += BALANCE_WALLETS_PER_POST) {
      chunks.push(unique.slice(i, i + BALANCE_WALLETS_PER_POST));
    }
    const responses = new Map<string, RpcResponse<unknown>>();
    await forEachWithConcurrency(chunks, BATCH_CONCURRENCY, async (chunk) => {
      const result = await this.sendBatch<unknown>(chunk.flatMap(callsFor), 15_000);
      for (const [id, res] of result) responses.set(id, res);
    });
    // An endpoint that doesn't serve the paged method says so per call; it never will, so the
    // rest of this process uses the unpaged one - starting with this batch.
    // Answered, yet not one call succeeded, stands it down for a while instead.
    if (paged) {
      const answers = [...responses.values()];
      if (answers.some((res) => res.error?.code === RPC_METHOD_NOT_FOUND)) {
        this.taboV2Unavailable = true;
        logger.warn("getTokenAccountsByOwnerV2 not served - reading token balances unpaged");
        return this.getTokenBalancesBatch(unique);
      }
      if (answers.length > 0 && answers.every((res) => res.error)) {
        this.taboV2StoodDownUntil = Date.now() + TABO_V2_STANDDOWN_MS;
        logger.warn(
          "getTokenAccountsByOwnerV2 answered only errors - reading token balances unpaged for now",
          {
            error: answers[0]?.error,
          },
        );
        return this.getTokenBalancesBatch(unique);
      }
    }
    for (const address of unique) {
      const balances = new Map<string, bigint>();
      let ok = true;
      let truncated = false;
      for (let p = 0; p < TOKEN_PROGRAM_IDS.length && ok; p += 1) {
        const res = responses.get(`tabo-${p}-${address}`);
        const page = res && !res.error ? tokenAccountsPage(res.result) : null;
        if (!page) {
          ok = false;
          break;
        }
        if (page.more) truncated = true;
        for (const entry of page.accounts) {
          const parsed = parseTokenAccountSlice(entry);
          if (!parsed || parsed.amount === 0n) continue;
          balances.set(parsed.mint, (balances.get(parsed.mint) ?? 0n) + parsed.amount);
        }
      }
      out.set(
        address,
        ok ? { status: "found", balances, ...(truncated ? { truncated } : {}) } : { status: "failed" },
      );
    }
    return out;
  }

  /**
   * Each mint's decimals, read from the mint account's one decimals byte (offset 44, the same in
   * both token programs) - 1 credit per 100 mints. A mint missing from the result was not read
   * (failed chunk, or no such account).
   */
  async getMintDecimals(mints: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(mints)];
    const out = new Map<string, number>();
    if (unique.length === 0) return out;
    const accounts = await this.getMultipleAccounts<{ data?: unknown }>(unique, {
      encoding: "base64",
      dataSlice: { offset: 44, length: 1 },
    });
    for (const [mint, account] of accounts) {
      if (account === "failed" || !account.value) continue;
      const bytes = decodeBase64Data(account.value.data);
      if (bytes && bytes.length >= 1) out.set(mint, bytes[0]!);
    }
    return out;
  }

  /**
   * Whether DAS-backed holdings lookups are currently believed usable, for health/diagnostics.
   *
   * False while stood down after an outage as well as when permanently unavailable - callers
   * skip the pass either way - but the stand-down expires on its own, so this returns true again
   * without a redeploy.
   */
  get holdingsLookupAvailable(): boolean {
    return !this.dasUnavailable && Date.now() >= this.dasStoodDownUntil;
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
    const count = () => this.callCounts.set(method, (this.callCounts.get(method) ?? 0) + 1);
    count();
    try {
      return await fetchJson<RpcResponse<T>>(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
        timeoutMs,
        retries: 1,
        onRetry: count,
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

    if (!this.holdingsLookupAvailable) {
      for (const address of unique) out.set(address, { status: "unsupported" });
      return out;
    }

    let methodMissing = false;
    let usable = 0;
    /** Rounds where the endpoint answered at all - the barren latch only judges these. */
    let answered = 0;
    // Batch-wide price coverage, for the guard below.
    let itemsSeen = 0;
    let pricedItems = 0;

    await forEachWithConcurrency(unique, DAS_CONCURRENCY, async (address) => {
      // Paged rather than one shot: a wallet holding more than DAS_PAGE_LIMIT fungibles used to
      // be silently cut off at the first page, which undervalues it and so overstates how empty
      // it looks. Almost every wallet finishes on page one, so the loop costs nothing in practice.
      const items: DasFungibleItem[] = [];
      let truncated = false;
      for (let page = 1; page <= DAS_MAX_PAGES; page += 1) {
        const res = await this.sendSingle<{ items?: DasFungibleItem[] }>(
          "searchAssets",
          {
            ownerAddress: address,
            tokenType: "fungible",
            page,
            limit: DAS_PAGE_LIMIT,
            // params.options, NOT displayOptions - that spelling belongs to getAssetsByOwner, and
            // searchAssets nests these under `options`. It is also already the default; sent
            // explicitly so the intent (never pay for dust accounts) survives a reader.
            options: { showZeroBalance: false },
          },
          15_000,
        );

        // No response at all: unreachable, timed out, or a transport error. A failure for this
        // wallet, but deliberately NOT evidence about whether the endpoint serves DAS.
        if (!res) {
          out.set(address, { status: "failed" });
          return;
        }
        if (page === 1) answered += 1;
        if (res.error) {
          if (res.error.code === RPC_METHOD_NOT_FOUND) methodMissing = true;
          out.set(address, { status: "failed" });
          return;
        }

        const pageItems = res.result?.items ?? [];
        items.push(...pageItems);
        // A short page is the last page. A full one means there may be more.
        if (pageItems.length < DAS_PAGE_LIMIT) break;
        if (page === DAS_MAX_PAGES) truncated = true;
      }

      // Past the page cap the total is a floor of a floor. Said out loud rather than left to look
      // like a complete reading, since it can only make a wallet look emptier than it is.
      if (truncated) {
        logger.warn("searchAssets hit the page cap - wallet valued on a partial holding list", {
          address,
          pages: DAS_MAX_PAGES,
        });
      }

      // A successful call with no items is a real answer: this wallet holds nothing fungible.
      let total = 0;
      // Seeded with a zero for every requested mint, so "holds none of it" is recorded as a fact
      // rather than as a gap - see perMintUsd on WalletHoldingsResult.
      const perMintUsd: Record<string, number> = {};
      for (const mint of interesting) perMintUsd[mint] = 0;

      // Every priced holding, kept apart so the full list is only used when it is small enough.
      const pricedByMint: Record<string, number> = {};
      for (const item of items) {
        if (!item.id || CASH_EQUIVALENT_MINTS.has(item.id)) continue;
        itemsSeen += 1;
        const price = itemPriceUsd(item);
        if (price !== null) {
          pricedItems += 1;
          total += price;
          pricedByMint[item.id] = (pricedByMint[item.id] ?? 0) + price;
        }
      }
      const complete = !truncated && Object.keys(pricedByMint).length <= COMPLETE_BREAKDOWN_MAX;
      for (const [mint, usd] of Object.entries(pricedByMint)) {
        if (complete || interesting.has(mint)) perMintUsd[mint] = usd;
      }
      usable += 1;
      out.set(address, { status: "found", otherHoldingsUsd: total, perMintUsd, complete });
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

    // An explicit "method not found" is a fact about the endpoint and is final. A barren round is
    // not: an outage looks exactly the same from here, which is why it now only stands the lookup
    // down for a while instead of switching it off for the life of the process.
    //
    // A round nobody answered is not judged at all. Counting unreachable rounds toward the latch
    // is what let a few seconds of packet loss disable holdings lookups until the next deploy.
    if (methodMissing) {
      this.dasUnavailable = true;
      logger.warn("searchAssets not served by this endpoint - holdings lookups disabled");
    } else if (answered === 0) {
      logger.warn("searchAssets unreachable this round - not counted against the latch", {
        wallets: unique.length,
      });
    } else if (usable === 0) {
      this.dasBarrenRounds += 1;
      if (this.dasBarrenRounds >= DAS_FAILURE_LATCH_ROUNDS) {
        this.dasStoodDownUntil = Date.now() + DAS_STANDDOWN_MS;
        this.dasBarrenRounds = 0;
        logger.warn("searchAssets barren for too many rounds - standing down, will retry", {
          standDownMinutes: Math.round(DAS_STANDDOWN_MS / 60_000),
        });
      }
    } else {
      this.dasBarrenRounds = 0;
    }

    return out;
  }
}

function funderResultOf(
  found: { funder: string; amountSol: number; atMs: number | null } | null,
  how: { sorted?: true; reads?: number },
): FunderResult {
  return found
    ? {
        status: "found",
        funder: found.funder,
        amountSol: found.amountSol,
        fundedAt: found.atMs !== null ? new Date(found.atMs) : null,
        ...how,
      }
    : { status: "none", ...how };
}
