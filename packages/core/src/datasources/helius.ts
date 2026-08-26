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
   * Best-effort earliest-activity timestamp for any address (mint or wallet).
   * Only looks at the most recent 1000 signatures - if the address has more
   * history than that, we can't cheaply find genesis, so this returns null
   * rather than doing an expensive full paginated walk. Used two ways:
   * as a token-age fallback for mints (when a launchpad-provided creation
   * timestamp isn't available), and per-wallet by getFreshWalletPct below
   * to flag holder wallets that only exist to snipe one specific launch.
   */
  async getEarliestActivity(address: string): Promise<Date | null> {
    try {
      const res = await fetchJson<RpcSignaturesResponse>(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "getSignaturesForAddress",
          method: "getSignaturesForAddress",
          params: [address, { limit: 1000 }],
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
      logger.warn("getEarliestActivity failed", { address, error: String(err) });
      return null;
    }
  }

  /**
   * % of the given wallet addresses whose earliest known activity is within `withinHours` -
   * i.e. wallets that appear to exist only to have bought into this one launch. Returns null
   * (not 0) when the address list is empty, so callers can tell "nothing to check" apart from
   * "checked, found none fresh."
   *
   * Both ways getEarliestActivity can come back null (no signatures at all, or 1000+ meaning we
   * gave up rather than paginate) are treated as "not fresh" here, not "unknown, don't count
   * it either way": a wallet that already holds a meaningful chunk of a token's supply
   * necessarily has at least one transaction (the buy itself), so a true zero-signature result
   * is a rare indexing gap rather than a real answer; and 1000+ signatures unambiguously rules
   * out "funded in the last 24h" regardless of exactly how old it really is. This is a
   * risk-scoring input a user opts into (maxFreshTop10WalletPct), not a security gate, so
   * erring toward under- rather than over-counting on missing data is the appropriate default -
   * unlike the mandatory rug screen, which fails closed the other way on purpose.
   */
  async getFreshWalletPct(addresses: string[], withinHours = 24, concurrency = 5): Promise<number | null> {
    if (addresses.length === 0) return null;

    const cutoffMs = Date.now() - withinHours * 3_600_000;
    let freshCount = 0;
    const queue = [...addresses];

    const worker = async () => {
      while (queue.length > 0) {
        const address = queue.shift();
        if (!address) continue;
        const earliest = await this.getEarliestActivity(address);
        if (earliest && earliest.getTime() >= cutoffMs) freshCount += 1;
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, addresses.length) }, worker));
    return (freshCount / addresses.length) * 100;
  }
}
