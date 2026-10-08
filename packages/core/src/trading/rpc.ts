import { fetchJson } from "../datasources/httpClient.js";
import { resolveSolanaRpcUrl, type SolanaRpcOptions } from "../subscription/solanaRpc.js";

/**
 * The chain calls the trading bot makes. Its own small client rather than more methods on
 * SolanaRpc: that one reads at `finalized` because it grants paid access, while a trade wants
 * `confirmed` answers (a position that waits 13 extra seconds per sale to learn it sold is a
 * position that misses its next exit). Same endpoint resolution, so SOLANA_RPC_URL / Helius apply.
 *
 * Every read returns null when the RPC failed, never a guess: the engine leaves a position as it
 * was and tries again on the next tick rather than trading on a missing answer.
 */

interface Envelope<T> {
  result?: T;
  error?: { code: number; message: string };
}

export interface TransactionFill {
  /** The transaction failed on chain (fee still paid). */
  failed: boolean;
  error: string | null;
  /** The wallet's SOL change, fees included (negative on a buy). */
  lamportsDelta: bigint;
  /** The wallet's change in the mint's raw units across all its token accounts. */
  tokenDelta: bigint;
  decimals: number | null;
}

interface TokenBalanceEntry {
  owner?: string;
  mint?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}

export class TradingRpc {
  readonly url: string;

  constructor(options: SolanaRpcOptions = {}) {
    this.url = resolveSolanaRpcUrl(options);
  }

  protected async call<T>(method: string, params: unknown[], timeoutMs = 15_000): Promise<T | null> {
    try {
      const body = await fetchJson<Envelope<T>>(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        timeoutMs,
        retries: 1,
      });
      if (body.error) throw new RpcError(method, body.error.code, body.error.message);
      return body.result ?? null;
    } catch (err) {
      if (err instanceof RpcError) throw err;
      return null;
    }
  }

  async getBalance(address: string): Promise<bigint | null> {
    const out = await this.call<{ value: number }>("getBalance", [
      address,
      { commitment: "confirmed" },
    ]).catch(() => null);
    return out && typeof out.value === "number" ? BigInt(out.value) : null;
  }

  async getBlockHeight(): Promise<number | null> {
    return this.call<number>("getBlockHeight", [{ commitment: "confirmed" }]).catch(() => null);
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number } | null> {
    const out = await this.call<{ value?: { blockhash: string; lastValidBlockHeight: number } }>(
      "getLatestBlockhash",
      [{ commitment: "confirmed" }],
    ).catch(() => null);
    return out?.value ?? null;
  }

  /**
   * Runs the signed transaction against current state without sending it, and reports the
   * wallet's SOL balance after it. The engine checks that number before sending anything a swap
   * API built: a transaction that would take more SOL than the trade is refused, whatever else
   * it does. Null when the RPC could not answer.
   */
  async simulate(
    base64Tx: string,
    wallet: string,
  ): Promise<{ error: string | null; lamportsAfter: bigint | null; logs: string[] } | null> {
    try {
      const out = await this.call<{
        value?: { err: unknown; logs?: string[] | null; accounts?: ({ lamports?: number } | null)[] | null };
      }>("simulateTransaction", [
        base64Tx,
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: "confirmed",
          accounts: { encoding: "base64", addresses: [wallet] },
        },
      ]);
      if (!out?.value) return null;
      const lamports = out.value.accounts?.[0]?.lamports;
      return {
        error: out.value.err ? JSON.stringify(out.value.err) : null,
        lamportsAfter: typeof lamports === "number" ? BigInt(lamports) : null,
        logs: (out.value.logs ?? []).slice(-20),
      };
    } catch (err) {
      return { error: String(err), lamportsAfter: null, logs: [] };
    }
  }

  /**
   * Sends a signed transaction. Skips preflight - the engine simulated it a moment ago - and lets
   * the RPC rebroadcast it until the blockhash expires. Throws only on a definite refusal; a lost
   * reply is not one (the signature is already recorded, so confirmation settles it either way).
   */
  async send(base64Tx: string): Promise<void> {
    await this.call<string>(
      "sendTransaction",
      [base64Tx, { encoding: "base64", skipPreflight: true, maxRetries: 5 }],
      20_000,
    );
  }

  /** Where a signature stands: landed (ok or failed), or not seen (null status). Null when unknown. */
  async getSignatureStatus(
    signature: string,
  ): Promise<{ seen: false } | { seen: true; confirmed: boolean; error: string | null } | null> {
    const out = await this.call<{
      value?: ({ err: unknown; confirmationStatus?: string | null } | null)[];
    }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]).catch(() => null);
    if (!out?.value) return null;
    const status = out.value[0];
    if (!status) return { seen: false };
    const confirmed = status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized";
    return { seen: true, confirmed, error: status.err ? JSON.stringify(status.err) : null };
  }

  /** What a landed transaction did to the wallet: its SOL change and its change in `mint`. */
  async getTransactionFill(
    signature: string,
    wallet: string,
    mint: string | null,
  ): Promise<TransactionFill | null> {
    const tx = await this.call<{
      meta?: {
        err: unknown;
        preBalances?: number[];
        postBalances?: number[];
        preTokenBalances?: TokenBalanceEntry[];
        postTokenBalances?: TokenBalanceEntry[];
      } | null;
      transaction?: { message?: { accountKeys?: ({ pubkey?: string } | string)[] } };
    }>("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]).catch(() => null);
    if (!tx?.meta) return null;
    const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
      typeof k === "string" ? k : k.pubkey,
    );
    const index = keys.indexOf(wallet);
    if (index < 0) return null;
    const pre = tx.meta.preBalances?.[index];
    const post = tx.meta.postBalances?.[index];
    if (typeof pre !== "number" || typeof post !== "number") return null;
    let decimals: number | null = null;
    const sum = (entries: TokenBalanceEntry[] | undefined) => {
      let total = 0n;
      for (const e of entries ?? []) {
        if (e.owner !== wallet || e.mint !== mint) continue;
        const raw = e.uiTokenAmount?.amount;
        if (typeof raw === "string" && /^\d+$/.test(raw)) total += BigInt(raw);
        if (typeof e.uiTokenAmount?.decimals === "number") decimals = e.uiTokenAmount.decimals;
      }
      return total;
    };
    const tokenDelta = mint ? sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances) : 0n;
    return {
      failed: tx.meta.err != null,
      error: tx.meta.err != null ? JSON.stringify(tx.meta.err) : null,
      lamportsDelta: BigInt(post) - BigInt(pre),
      tokenDelta,
      decimals,
    };
  }

  /** The wallet's total balance of `mint` across its token accounts (either token program). */
  async getTokenBalance(
    owner: string,
    mint: string,
  ): Promise<{ raw: bigint; decimals: number | null } | null> {
    const out = await this.call<{
      value?: {
        account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } } };
      }[];
    }>("getTokenAccountsByOwner", [
      owner,
      { mint },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]).catch(() => null);
    if (!out || !Array.isArray(out.value)) return null;
    let raw = 0n;
    let decimals: number | null = null;
    for (const entry of out.value) {
      const amount = entry.account?.data?.parsed?.info?.tokenAmount;
      if (typeof amount?.amount === "string" && /^\d+$/.test(amount.amount)) raw += BigInt(amount.amount);
      if (typeof amount?.decimals === "number") decimals = amount.decimals;
    }
    return { raw, decimals };
  }
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${code} ${message}`);
  }
}
