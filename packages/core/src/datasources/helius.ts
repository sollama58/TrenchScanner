import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";

const logger = createLogger("helius");

/**
 * Thin Solana JSON-RPC client. Uses Helius's RPC endpoint when an API key is
 * configured (recommended for production - higher rate limits, reliability),
 * and transparently falls back to a public RPC endpoint otherwise so local
 * dev works without signing up for anything.
 *
 * This exists as a fallback/secondary source alongside RugCheckClient: if
 * RugCheck is unavailable or hasn't indexed a very new mint yet, we can still
 * get mint/freeze authority status directly from chain.
 */

interface RpcMintAccountInfo {
  result?: {
    value?: {
      data?: {
        parsed?: {
          info?: {
            mintAuthority: string | null;
            freezeAuthority: string | null;
          };
        };
      };
    } | null;
  };
  error?: { code: number; message: string };
}

interface RpcSignaturesResponse {
  result?: { signature: string; blockTime: number | null }[];
  error?: { code: number; message: string };
}

export interface MintAuthorityStatus {
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
}

export interface HeliusClientOptions {
  apiKey?: string;
  /** Overrides the derived RPC URL entirely - mainly for tests. */
  rpcUrl?: string;
}

const PUBLIC_FALLBACK_RPC = "https://solana-rpc.publicnode.com";

export class HeliusClient {
  private readonly rpcUrl: string;
  readonly usingHelius: boolean;

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
  }

  /** Reads mint/freeze authority straight from the mint account (jsonParsed). */
  async getMintAuthorityStatus(mintAddress: string): Promise<MintAuthorityStatus | null> {
    try {
      const res = await fetchJson<RpcMintAccountInfo>(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "getAccountInfo",
          method: "getAccountInfo",
          params: [mintAddress, { encoding: "jsonParsed" }],
        }),
        timeoutMs: 8000,
        retries: 1,
      });
      if (res.error) {
        logger.warn("rpc error on getAccountInfo", { mintAddress, error: res.error });
        return null;
      }
      const info = res.result?.value?.data?.parsed?.info;
      if (!info) return null;
      return {
        mintAuthorityActive: Boolean(info.mintAuthority),
        freezeAuthorityActive: Boolean(info.freezeAuthority),
      };
    } catch (err) {
      logger.warn("getMintAuthorityStatus failed", { mintAddress, error: String(err) });
      return null;
    }
  }

  /**
   * Best-effort earliest-activity timestamp for a mint, used as a token-age
   * fallback when a launchpad-provided creation timestamp isn't available.
   * Only looks at the most recent 1000 signatures - if the mint has traded
   * more than that, we can't cheaply find genesis, so this returns null
   * rather than doing an expensive full paginated walk.
   */
  async getEarliestActivity(mintAddress: string): Promise<Date | null> {
    try {
      const res = await fetchJson<RpcSignaturesResponse>(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "getSignaturesForAddress",
          method: "getSignaturesForAddress",
          params: [mintAddress, { limit: 1000 }],
        }),
        timeoutMs: 10_000,
        retries: 1,
      });
      const sigs = res.result;
      if (!sigs || sigs.length === 0) return null;
      if (sigs.length === 1000) {
        // Likely more history beyond this page; treat age as indeterminate rather than wrong.
        return null;
      }
      const oldest = sigs[sigs.length - 1];
      if (!oldest?.blockTime) return null;
      return new Date(oldest.blockTime * 1000);
    } catch (err) {
      logger.warn("getEarliestActivity failed", { mintAddress, error: String(err) });
      return null;
    }
  }
}
