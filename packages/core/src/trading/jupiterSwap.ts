/**
 * Where the bot's swaps are built: Jupiter's Swap API (quote, then a transaction built for the
 * quote) and Price API, with PumpPortal as the fallback route for Pump.fun tokens Jupiter has no
 * route for yet (a mint seconds old, or one mid-migration from the bonding curve to PumpSwap).
 *
 * Separate from datasources/jupiter.ts (the Tokens API the scan prices from) and, when
 * TRADING_JUPITER_API_KEY is set, on its own key: the scan's jobs spend most of the free plan's
 * 60 calls a minute, and a sale must never queue behind a price sweep.
 *
 * Whatever a route returns is only bytes to the engine: every transaction goes through the guard
 * (txGuard.ts) before it is signed, whichever route built it.
 */

import { TransientError } from "./errors.js";
import type { InstructionSpec } from "./transaction.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  /** The rest of the quote, passed back to /swap untouched. */
  [key: string]: unknown;
}

/** The route has no way to trade this token (no pool, no liquidity, not tradable). */
export class NoRouteError extends Error {}
/** The API is throttling us; try again later rather than counting it against the position. */
export class RateLimitedError extends Error {}

export interface SwapClientOptions {
  apiKey?: string;
  /**
   * Another Jupiter key to fall back on when the first host answers 429 (the Pro trades borrow the
   * scan's JUPITER_API_KEY this way). Each key is its own account's limit.
   */
  backupApiKey?: string;
  /** One host only, with no fallback (tests, a proxy). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Second price source, for mints Jupiter's Price API has no price for or when it is down
   * (DexScreener by default; null for none). A stop-loss that can't read a price can't fire.
   */
  backupPrices?: ((mints: string[]) => Promise<Map<string, number>>) | null;
}

/** A DexScreener pair must have at least this much liquidity (USD) to price a token. */
const BACKUP_PRICE_MIN_LIQUIDITY_USD = 1_000;

/**
 * USD prices from DexScreener's tokens endpoint (keyless, 300 a minute), from each token's
 * deepest Solana pair where the token is the base, and only from pairs with real liquidity, so a
 * dust pool can't fake a price that trips an exit. Never throws: a mint it can't price is absent.
 */
export async function dexScreenerPricesUsd(
  mints: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const unique = [...new Set(mints)];
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    try {
      const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const pairs = (await res.json()) as {
        chainId?: string;
        baseToken?: { address?: string };
        priceUsd?: string;
        liquidity?: { usd?: number };
      }[];
      if (!Array.isArray(pairs)) continue;
      const best = new Map<string, number>();
      for (const pair of pairs) {
        const mint = pair.baseToken?.address;
        const price = Number(pair.priceUsd);
        const liquidity = pair.liquidity?.usd ?? 0;
        if (pair.chainId !== "solana" || !mint || !batch.includes(mint)) continue;
        if (!(Number.isFinite(price) && price > 0) || liquidity < BACKUP_PRICE_MIN_LIQUIDITY_USD) continue;
        if (liquidity > (best.get(mint) ?? -1)) {
          best.set(mint, liquidity);
          prices.set(mint, price);
        }
      }
    } catch {
      /* this batch stays unpriced */
    }
  }
  return prices;
}

export interface SwapClient {
  quote(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<SwapQuote>;
  swapTransaction(input: {
    quote: SwapQuote;
    userPublicKey: string;
    /** The most the priority fee may be (lamports); the route estimates it from recent fees. */
    maxPriorityFeeLamports: number;
    /** Instead of the estimate, exactly this fee (a retry raising its fee); never over the max. */
    priorityFeeLamports?: number;
    /** A Jito tip instead of any priority fee: the transaction is for Jito's block engine. */
    jitoTipLamports?: number;
  }): Promise<{ transaction: Uint8Array; lastValidBlockHeight: number | null }>;
  /** USD prices for mints (SOL included when asked); a mint Jupiter has no reliable price for is absent. */
  pricesUsd(mints: string[]): Promise<Map<string, number>>;
}

/** A route that builds a whole swap in one call, without a separate quote (PumpPortal). */
export interface FallbackSwapClient {
  /** Whether this route can trade the mint at all (PumpPortal: Pump.fun mints only). */
  handles(mint: string): boolean;
  build(input: {
    side: "buy" | "sell";
    mint: string;
    wallet: string;
    /** Buy: lamports to spend. Sell: raw token units to sell. */
    amount: bigint;
    /** Sell only: the token's decimals (PumpPortal takes whole tokens). */
    decimals: number | null;
    slippageBps: number;
    maxPriorityFeeLamports: number;
    /** Exactly this fee instead of the max (a retry raising its fee). */
    priorityFeeLamports?: number;
  }): Promise<{ transaction: Uint8Array; lastValidBlockHeight: number | null }>;
}

const NO_ROUTE_CODES = new Set([
  "COULD_NOT_FIND_ANY_ROUTE",
  "NO_ROUTES_FOUND",
  "TOKEN_NOT_TRADABLE",
  "ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT",
]);

/** A failed request is tried once more after this long when it might succeed on a second go. */
const REQUEST_RETRY_DELAY_MS = 300;

/**
 * One call to a swap API. A network failure, a timeout or a 5xx is tried once more (every call
 * here only reads or builds - nothing is sent - so a repeat is harmless), then thrown as a
 * TransientError. 429 is a RateLimitedError (not retried: the caller backs off); "no route" is
 * a NoRouteError; anything else a plain Error.
 */
async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  what: string,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(12_000) });
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, REQUEST_RETRY_DELAY_MS));
        continue;
      }
      throw new TransientError(`${what}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    if (res.status === 429) throw new RateLimitedError(`${what}: rate limited`);
    let code = "";
    let message = text.slice(0, 200);
    try {
      const body = JSON.parse(text) as { errorCode?: string; error?: string; message?: string };
      code = body.errorCode ?? "";
      message = body.error ?? body.message ?? message;
    } catch {
      /* not JSON */
    }
    if (NO_ROUTE_CODES.has(code) || /no route|not tradable|could not find any route/i.test(message)) {
      throw new NoRouteError(`${what}: no route (${code || message})`);
    }
    if (res.status >= 500) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, REQUEST_RETRY_DELAY_MS));
        continue;
      }
      throw new TransientError(`${what}: HTTP ${res.status} ${code} ${message}`.trim());
    }
    throw new Error(`${what}: HTTP ${res.status} ${code} ${message}`.trim());
  }
}

/** An instruction as Jupiter's swap-instructions endpoint returns it. */
interface JupiterInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  /** Base64. */
  data: string;
}

function fromJupiterInstruction(ix: JupiterInstruction): InstructionSpec {
  if (typeof ix?.programId !== "string" || !Array.isArray(ix.accounts) || typeof ix.data !== "string")
    throw new Error("Jupiter swap instructions: malformed instruction");
  return {
    programId: ix.programId,
    accounts: ix.accounts.map((a) => ({ pubkey: a.pubkey, writable: !!a.isWritable, signer: !!a.isSigner })),
    data: [...Buffer.from(ix.data, "base64")],
  };
}

/** One way into Jupiter: a host and the key (if any) it is called with. */
interface JupiterRoute {
  baseUrl: string;
  headers: Record<string, string>;
  /** Rate limited until then (epoch ms): the other routes go first. */
  coolUntil: number;
}

const KEYED_HOST = "https://api.jup.ag";
const KEYLESS_HOST = "https://lite-api.jup.ag";
/** How long a host that answered 429 is tried last: Jupiter's limits are per second or per minute. */
const RATE_LIMIT_COOLDOWN_MS = 10_000;

export class JupiterSwapClient implements SwapClient {
  private readonly routes: JupiterRoute[];
  private readonly fetchImpl: typeof fetch;
  private readonly backupPrices: ((mints: string[]) => Promise<Map<string, number>>) | null;

  constructor(options: SwapClientOptions = {}) {
    const route = (baseUrl: string, apiKey?: string): JupiterRoute => ({
      baseUrl: baseUrl.replace(/\/$/, ""),
      headers: { accept: "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
      coolUntil: 0,
    });
    // A 429 on one route moves the call to the next: the key's own account, a backup key's, then
    // the keyless host, whose limit is per IP (and the api's IP is shared with other services).
    const keys = [...new Set([options.apiKey, options.backupApiKey].filter((k): k is string => !!k))];
    this.routes = options.baseUrl
      ? [route(options.baseUrl, options.apiKey)]
      : [...keys.map((k) => route(KEYED_HOST, k)), route(KEYLESS_HOST)];
    this.fetchImpl = options.fetchImpl ?? fetch;
    const fetchImpl = this.fetchImpl;
    this.backupPrices =
      options.backupPrices !== undefined
        ? options.backupPrices
        : (mints) => dexScreenerPricesUsd(mints, fetchImpl);
  }

  /**
   * One Jupiter call, on the first route that isn't rate limited; a 429 sends it on to the next
   * route right away, and only when every route answered 429 is it a RateLimitedError.
   */
  private async call(path: string, init: RequestInit, what: string): Promise<Response> {
    const now = Date.now();
    const order = [...this.routes].sort((a, b) => Number(a.coolUntil > now) - Number(b.coolUntil > now));
    let limited: unknown = null;
    for (const r of order) {
      try {
        const res = await request(
          this.fetchImpl,
          `${r.baseUrl}${path}`,
          { ...init, headers: { ...r.headers, ...(init.headers as Record<string, string> | undefined) } },
          what,
        );
        r.coolUntil = 0;
        return res;
      } catch (err) {
        if (!(err instanceof RateLimitedError)) throw err;
        r.coolUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        limited = err;
      }
    }
    throw limited;
  }

  async quote(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    /** False lets the route hop through any token, not just Jupiter's liquid ones (default true). */
    restrictIntermediateTokens?: boolean;
  }) {
    const params = new URLSearchParams({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amount: input.amount.toString(),
      slippageBps: String(input.slippageBps),
      // Fewer hops through thin intermediate tokens: fewer ways for a memecoin route to fail.
      restrictIntermediateTokens: String(input.restrictIntermediateTokens ?? true),
    });
    const res = await this.call(`/swap/v1/quote?${params}`, {}, "Jupiter quote");
    const quote = (await res.json()) as SwapQuote & { error?: string };
    if (quote.error) throw new NoRouteError(`Jupiter quote: ${quote.error}`);
    if (typeof quote.outAmount !== "string" || typeof quote.otherAmountThreshold !== "string") {
      throw new Error("Jupiter quote: malformed response");
    }
    return quote;
  }

  async swapTransaction(input: Parameters<SwapClient["swapTransaction"]>[0]) {
    const exact =
      input.priorityFeeLamports !== undefined && input.priorityFeeLamports > 0
        ? Math.min(input.priorityFeeLamports, input.maxPriorityFeeLamports)
        : null;
    const res = await this.call(
      "/swap/v1/swap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quoteResponse: input.quote,
          userPublicKey: input.userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          dynamicSlippage: false,
          // Jupiter's estimate from recent fees ("veryHigh": the 75th percentile) under our cap, or,
          // for a retry after a send that never landed, exactly the raised fee.
          prioritizationFeeLamports:
            input.jitoTipLamports !== undefined && input.jitoTipLamports > 0
              ? { jitoTipLamports: input.jitoTipLamports }
              : exact !== null
                ? exact
                : input.maxPriorityFeeLamports > 0
                  ? {
                      priorityLevelWithMaxLamports: {
                        maxLamports: input.maxPriorityFeeLamports,
                        priorityLevel: "veryHigh",
                      },
                    }
                  : undefined,
        }),
      },
      "Jupiter swap",
    );
    const out = (await res.json()) as {
      swapTransaction?: string;
      lastValidBlockHeight?: number;
      error?: string;
    };
    if (!out.swapTransaction) throw new Error(`Jupiter swap: ${out.error ?? "no transaction returned"}`);
    return {
      transaction: Uint8Array.from(Buffer.from(out.swapTransaction, "base64")),
      lastValidBlockHeight: typeof out.lastValidBlockHeight === "number" ? out.lastValidBlockHeight : null,
    };
  }

  /**
   * The quote's swap as separate instructions (/swap/v1/swap-instructions) rather than a whole
   * transaction, for a caller that assembles its own: the Pro trades add their own priority fee
   * and a Helius Sender tip, which Jupiter's built transaction has no room for. Jupiter's own
   * compute-budget instructions are left out (the caller sets the price); its unit limit, from
   * its own simulation, is returned.
   */
  async swapInstructions(input: { quote: SwapQuote; userPublicKey: string }): Promise<{
    instructions: InstructionSpec[];
    lookupTables: string[];
    computeUnitLimit: number | null;
  }> {
    const res = await this.call(
      "/swap/v1/swap-instructions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quoteResponse: input.quote,
          userPublicKey: input.userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          dynamicSlippage: false,
        }),
      },
      "Jupiter swap instructions",
    );
    const out = (await res.json()) as {
      setupInstructions?: JupiterInstruction[];
      swapInstruction?: JupiterInstruction;
      cleanupInstruction?: JupiterInstruction | null;
      otherInstructions?: JupiterInstruction[];
      tokenLedgerInstruction?: JupiterInstruction | null;
      addressLookupTableAddresses?: string[];
      computeUnitLimit?: number;
      error?: string;
    };
    if (!out.swapInstruction) throw new Error(`Jupiter swap instructions: ${out.error ?? "none returned"}`);
    if (out.tokenLedgerInstruction)
      throw new Error("Jupiter swap instructions: token ledger routes aren't used");
    const list = [
      ...(out.otherInstructions ?? []),
      ...(out.setupInstructions ?? []),
      out.swapInstruction,
      ...(out.cleanupInstruction ? [out.cleanupInstruction] : []),
    ];
    return {
      instructions: list.map(fromJupiterInstruction),
      lookupTables: Array.isArray(out.addressLookupTableAddresses) ? out.addressLookupTableAddresses : [],
      computeUnitLimit:
        typeof out.computeUnitLimit === "number" && out.computeUnitLimit > 0 ? out.computeUnitLimit : null,
    };
  }

  /**
   * Jupiter's prices, with the backup source filling the mints Jupiter has none for, or all of
   * them while Jupiter is down. Throws Jupiter's error only when the backup priced nothing either.
   */
  async pricesUsd(mints: string[]): Promise<Map<string, number>> {
    let prices: Map<string, number>;
    let failure: unknown = null;
    try {
      prices = await this.jupiterPricesUsd(mints);
    } catch (err) {
      failure = err;
      prices = new Map();
    }
    const missing = [...new Set(mints)].filter((m) => !prices.has(m));
    if (missing.length > 0 && this.backupPrices) {
      const backup = await this.backupPrices(missing).catch(() => new Map<string, number>());
      for (const [mint, price] of backup) prices.set(mint, price);
    }
    if (failure !== null && prices.size === 0) throw failure;
    return prices;
  }

  private async jupiterPricesUsd(mints: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    const unique = [...new Set(mints)];
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      const res = await this.call(`/price/v3?ids=${batch.join(",")}`, {}, "Jupiter price");
      const out = (await res.json()) as Record<string, { usdPrice?: number } | null>;
      for (const mint of batch) {
        const price = out?.[mint]?.usdPrice;
        if (typeof price === "number" && Number.isFinite(price) && price > 0) prices.set(mint, price);
      }
    }
    return prices;
  }
}

/**
 * PumpPortal's local-transaction API: builds a Pump.fun bonding-curve or PumpSwap trade for the
 * wallet to sign itself (the key never leaves this server). It answers with the serialized
 * transaction's raw bytes, not JSON, and no expiry height - the engine derives its own.
 * PumpPortal takes a small fee inside the transaction; the guard's SOL allowance bounds it.
 */
export class PumpPortalSwapClient implements FallbackSwapClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { url?: string; fetchImpl?: typeof fetch } = {}) {
    this.url = options.url ?? "https://pumpportal.fun/api/trade-local";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  handles(mint: string): boolean {
    return mint.endsWith("pump");
  }

  async build(input: Parameters<FallbackSwapClient["build"]>[0]) {
    let amount: string;
    if (input.side === "buy") {
      amount = (Number(input.amount) / 1e9).toFixed(9);
    } else {
      if (input.decimals === null) throw new Error("PumpPortal sell: token decimals unknown");
      const scale = 10n ** BigInt(input.decimals);
      const whole = input.amount / scale;
      const frac = (input.amount % scale).toString().padStart(input.decimals, "0").replace(/0+$/, "");
      amount = frac ? `${whole}.${frac}` : whole.toString();
    }
    const res = await request(
      this.fetchImpl,
      this.url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: input.wallet,
          action: input.side,
          mint: input.mint,
          amount,
          denominatedInSol: input.side === "buy" ? "true" : "false",
          slippage: Math.max(1, Math.round(input.slippageBps / 100)),
          // PumpPortal pays the fee it is given: the raised one on a retry, else the cap.
          priorityFee: (input.priorityFeeLamports ?? input.maxPriorityFeeLamports) / 1e9,
          pool: "auto",
        }),
      },
      "PumpPortal",
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 100) throw new Error("PumpPortal: no transaction returned");
    return { transaction: bytes, lastValidBlockHeight: null };
  }
}
