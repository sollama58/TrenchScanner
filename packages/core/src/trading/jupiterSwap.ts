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
  baseUrl?: string;
  fetchImpl?: typeof fetch;
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

export class JupiterSwapClient implements SwapClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SwapClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ?? (options.apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag")
    ).replace(/\/$/, "");
    this.headers = { accept: "application/json", ...(options.apiKey ? { "x-api-key": options.apiKey } : {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async quote(input: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }) {
    const params = new URLSearchParams({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amount: input.amount.toString(),
      slippageBps: String(input.slippageBps),
      // Fewer hops through thin intermediate tokens: fewer ways for a memecoin route to fail.
      restrictIntermediateTokens: "true",
    });
    const res = await request(
      this.fetchImpl,
      `${this.baseUrl}/swap/v1/quote?${params}`,
      { headers: this.headers },
      "Jupiter quote",
    );
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
    const res = await request(
      this.fetchImpl,
      `${this.baseUrl}/swap/v1/swap`,
      {
        method: "POST",
        headers: { ...this.headers, "content-type": "application/json" },
        body: JSON.stringify({
          quoteResponse: input.quote,
          userPublicKey: input.userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          dynamicSlippage: false,
          // Jupiter's estimate from recent fees ("veryHigh": the 75th percentile) under our cap, or,
          // for a retry after a send that never landed, exactly the raised fee.
          prioritizationFeeLamports:
            exact !== null
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

  async pricesUsd(mints: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    const unique = [...new Set(mints)];
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      const res = await request(
        this.fetchImpl,
        `${this.baseUrl}/price/v3?ids=${batch.join(",")}`,
        { headers: this.headers },
        "Jupiter price",
      );
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
