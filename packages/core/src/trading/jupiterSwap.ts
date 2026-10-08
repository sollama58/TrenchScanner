import { fetchJson } from "../datasources/httpClient.js";

/**
 * Jupiter's Swap API (quote, then a transaction built for the quote) and Price API, for the
 * trading bot. Jupiter routes Pump.fun bonding curves, PumpSwap and Raydium alike, so one client
 * covers a token from launch through graduation.
 *
 * Separate from datasources/jupiter.ts (the Tokens API the scan prices from) and, when
 * TRADING_JUPITER_API_KEY is set, on its own key: the scan's jobs spend most of the free plan's
 * 60 calls a minute, and a sale must never queue behind a price sweep.
 */

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

export interface SwapClientOptions {
  apiKey?: string;
  baseUrl?: string;
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
    maxPriorityFeeLamports: number;
  }): Promise<{ transaction: Uint8Array; lastValidBlockHeight: number }>;
  /** USD prices for mints (SOL included when asked); a mint Jupiter has no reliable price for is absent. */
  pricesUsd(mints: string[]): Promise<Map<string, number>>;
}

export class JupiterSwapClient implements SwapClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: SwapClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ?? (options.apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag")
    ).replace(/\/$/, "");
    this.headers = { accept: "application/json", ...(options.apiKey ? { "x-api-key": options.apiKey } : {}) };
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
    const quote = await fetchJson<SwapQuote & { error?: string }>(`${this.baseUrl}/swap/v1/quote?${params}`, {
      headers: this.headers,
      timeoutMs: 10_000,
      retries: 1,
    });
    if (quote.error || typeof quote.outAmount !== "string") {
      throw new Error(`no route: ${quote.error ?? "quote without outAmount"}`);
    }
    return quote;
  }

  async swapTransaction(input: { quote: SwapQuote; userPublicKey: string; maxPriorityFeeLamports: number }) {
    const out = await fetchJson<{ swapTransaction?: string; lastValidBlockHeight?: number; error?: string }>(
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
          prioritizationFeeLamports:
            input.maxPriorityFeeLamports > 0
              ? {
                  priorityLevelWithMaxLamports: {
                    maxLamports: input.maxPriorityFeeLamports,
                    priorityLevel: "veryHigh",
                  },
                }
              : undefined,
        }),
        timeoutMs: 15_000,
        retries: 1,
      },
    );
    if (!out.swapTransaction || typeof out.lastValidBlockHeight !== "number") {
      throw new Error(`swap build failed: ${out.error ?? "no transaction returned"}`);
    }
    return {
      transaction: Uint8Array.from(Buffer.from(out.swapTransaction, "base64")),
      lastValidBlockHeight: out.lastValidBlockHeight,
    };
  }

  async pricesUsd(mints: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    const unique = [...new Set(mints)];
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      const out = await fetchJson<Record<string, { usdPrice?: number } | null>>(
        `${this.baseUrl}/price/v3?ids=${batch.join(",")}`,
        { headers: this.headers, timeoutMs: 10_000, retries: 1 },
      );
      for (const mint of batch) {
        const price = out?.[mint]?.usdPrice;
        if (typeof price === "number" && Number.isFinite(price) && price > 0) prices.set(mint, price);
      }
    }
    return prices;
  }
}
