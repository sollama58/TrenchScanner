import { fetchJson } from "../datasources/httpClient.js";
import { resolveSolanaRpcUrl, type SolanaRpcOptions } from "../subscription/solanaRpc.js";
import type { GuardRpc, ParsedAccountState, WalletTokenAccount } from "./txGuard.js";
import { PROGRAM } from "./txGuard.js";

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
  /** When the block landed, when the RPC knows. */
  blockTime: Date | null;
}

interface TokenBalanceEntry {
  owner?: string;
  mint?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}

interface RawAccount {
  lamports?: number;
  owner?: string;
  data?:
    | [string, string]
    | {
        program?: string;
        parsed?: {
          type?: string;
          info?: {
            mint?: string;
            owner?: string;
            state?: string;
            delegate?: string;
            closeAuthority?: string;
            tokenAmount?: { amount?: string; decimals?: number };
          };
        };
      };
}

/** A jsonParsed account as the guard wants it. */
export function parseAccountState(raw: RawAccount | null | undefined): ParsedAccountState | null {
  if (!raw || typeof raw.lamports !== "number" || typeof raw.owner !== "string") return null;
  let token: ParsedAccountState["token"] = null;
  const data = raw.data;
  if (data && !Array.isArray(data) && data.parsed?.type === "account" && data.parsed.info) {
    const info = data.parsed.info;
    const amount = info.tokenAmount?.amount;
    if (
      typeof info.mint === "string" &&
      typeof info.owner === "string" &&
      typeof amount === "string" &&
      /^\d+$/.test(amount)
    ) {
      token = {
        mint: info.mint,
        owner: info.owner,
        amount: BigInt(amount),
        delegate: info.delegate ?? null,
        closeAuthority: info.closeAuthority ?? null,
        state: info.state ?? null,
      };
    }
  }
  return { lamports: BigInt(raw.lamports), owner: raw.owner, token };
}

/** A mint account's authorities and Token-2022 extensions. */
export interface MintInfo {
  /** The token program that owns it. */
  program: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Token-2022 extension names, as the RPC's jsonParsed encoding names them. */
  extensions: string[];
}

export class TradingRpc implements GuardRpc {
  readonly url: string;

  constructor(options: SolanaRpcOptions = {}) {
    this.url = resolveSolanaRpcUrl(options);
  }

  /** One JSON-RPC call. Throws RpcError when the node answered with an error; null on no answer. */
  protected async call<T>(
    method: string,
    params: unknown[],
    timeoutMs = 15_000,
    retries = 1,
  ): Promise<T | null> {
    try {
      const body = await fetchJson<Envelope<T>>(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        timeoutMs,
        retries,
      });
      if (body.error) throw new RpcError(method, body.error.code, body.error.message);
      return body.result ?? null;
    } catch (err) {
      if (err instanceof RpcError) throw err;
      return null;
    }
  }

  /** `call` for reads: an RPC error is just "no answer". */
  private async read<T>(method: string, params: unknown[], timeoutMs?: number): Promise<T | null> {
    return this.call<T>(method, params, timeoutMs).catch(() => null);
  }

  async getBalance(address: string): Promise<bigint | null> {
    const out = await this.read<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
    return out && typeof out.value === "number" ? BigInt(out.value) : null;
  }

  async getBlockHeight(): Promise<number | null> {
    return this.read<number>("getBlockHeight", [{ commitment: "confirmed" }]);
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number } | null> {
    const out = await this.read<{ value?: { blockhash: string; lastValidBlockHeight: number } }>(
      "getLatestBlockhash",
      [{ commitment: "confirmed" }],
    );
    return out?.value ?? null;
  }

  async getAccountsData(addresses: string[]): Promise<(Uint8Array | null)[] | null> {
    const out = await this.read<{ value?: (RawAccount | null)[] }>("getMultipleAccounts", [
      addresses,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!out?.value || out.value.length !== addresses.length) return null;
    return out.value.map((a) =>
      a && Array.isArray(a.data) ? Uint8Array.from(Buffer.from(a.data[0], "base64")) : null,
    );
  }

  async getParsedAccounts(addresses: string[]): Promise<(ParsedAccountState | null)[] | null> {
    const out: (ParsedAccountState | null)[] = [];
    // getMultipleAccounts takes at most 100 keys a call.
    for (let i = 0; i < addresses.length; i += 100) {
      const page = await this.read<{ value?: (RawAccount | null)[] }>("getMultipleAccounts", [
        addresses.slice(i, i + 100),
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      if (!page?.value) return null;
      out.push(...page.value.map(parseAccountState));
    }
    return out;
  }

  /**
   * Runs an (unsigned) transaction against current state without sending it, and reports the
   * watched accounts' state after it - what the guard checks before anything is signed.
   */
  async simulateParsed(
    base64Tx: string,
    addresses: string[],
  ): Promise<{ error: string | null; logs: string[]; accounts: (ParsedAccountState | null)[] } | null> {
    try {
      const out = await this.call<{
        value?: { err: unknown; logs?: string[] | null; accounts?: (RawAccount | null)[] | null };
      }>("simulateTransaction", [
        base64Tx,
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: "confirmed",
          accounts: { encoding: "jsonParsed", addresses },
        },
      ]);
      if (!out?.value) return null;
      return {
        error: out.value.err ? JSON.stringify(out.value.err) : null,
        logs: (out.value.logs ?? []).slice(-20),
        accounts: (out.value.accounts ?? []).map(parseAccountState),
      };
    } catch {
      // The node refused the request itself (not the transaction): unavailable, not a verdict.
      return null;
    }
  }

  /**
   * What recent transactions writing `accounts` paid per compute unit (micro-lamports): the 75th
   * percentile of the last ~150 slots' minimum landing price. Null when the RPC didn't answer.
   */
  async getPriorityFeeEstimate(accounts: string[]): Promise<bigint | null> {
    const out = await this.read<{ slot?: number; prioritizationFee?: number }[]>(
      "getRecentPrioritizationFees",
      [accounts.slice(0, 128)],
    );
    if (!Array.isArray(out)) return null;
    const fees = out
      .map((e) => e.prioritizationFee)
      .filter((f): f is number => typeof f === "number" && Number.isFinite(f) && f >= 0)
      .sort((a, b) => a - b);
    if (fees.length === 0) return 0n;
    return BigInt(Math.floor(fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))]!));
  }

  /** A mint's authorities and extensions; null when it can't be read or isn't a mint. */
  async getMintInfo(mint: string): Promise<MintInfo | null> {
    const out = await this.read<{
      value?: {
        owner?: string;
        data?: {
          parsed?: {
            type?: string;
            info?: {
              mintAuthority?: string | null;
              freezeAuthority?: string | null;
              extensions?: { extension?: string }[];
            };
          };
        };
      } | null;
    }>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const v = out?.value;
    const info = v?.data?.parsed?.info;
    if (!v || typeof v.owner !== "string" || v.data?.parsed?.type !== "mint" || !info) return null;
    return {
      program: v.owner,
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      extensions: (info.extensions ?? []).map((e) => e.extension ?? "unknown"),
    };
  }

  async getWalletTokenAccounts(owner: string): Promise<WalletTokenAccount[] | null> {
    const out: WalletTokenAccount[] = [];
    for (const programId of [PROGRAM.token, PROGRAM.token2022]) {
      const page = await this.read<{ value?: { pubkey?: string; account?: RawAccount }[] }>(
        "getTokenAccountsByOwner",
        [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }],
      );
      if (!page || !Array.isArray(page.value)) return null;
      for (const entry of page.value) {
        const state = parseAccountState(entry.account);
        if (typeof entry.pubkey === "string" && state?.token) {
          out.push({ address: entry.pubkey, programId, mint: state.token.mint });
        }
      }
    }
    return out;
  }

  /**
   * Sends a signed transaction, once - no client retry (a resend is the engine's decision, by the
   * same signature). Skips preflight: the guard simulated it a moment ago. Never throws: whether
   * it landed is for confirmation to settle, since an error reply does not prove it was not
   * forwarded. Returns the node's error text, if any, for the record.
   */
  async send(base64Tx: string): Promise<string | null> {
    try {
      await this.call<string>(
        "sendTransaction",
        [base64Tx, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
        15_000,
        0,
      );
      return null;
    } catch (err) {
      return String(err instanceof Error ? err.message : err);
    }
  }

  /** Where a signature stands: landed (ok or failed), or not seen (null status). Null when unknown. */
  async getSignatureStatus(
    signature: string,
  ): Promise<{ seen: false } | { seen: true; confirmed: boolean; error: string | null } | null> {
    const out = await this.read<{
      value?: ({ err: unknown; confirmationStatus?: string | null } | null)[];
    }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
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
    const tx = await this.read<{
      blockTime?: number | null;
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
    ]);
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
    const total = (entries: TokenBalanceEntry[] | undefined) => {
      let sum = 0n;
      for (const e of entries ?? []) {
        if (e.owner !== wallet || e.mint !== mint) continue;
        const raw = e.uiTokenAmount?.amount;
        if (typeof raw === "string" && /^\d+$/.test(raw)) sum += BigInt(raw);
        if (typeof e.uiTokenAmount?.decimals === "number") decimals = e.uiTokenAmount.decimals;
      }
      return sum;
    };
    const tokenDelta = mint ? total(tx.meta.postTokenBalances) - total(tx.meta.preTokenBalances) : 0n;
    return {
      failed: tx.meta.err != null,
      error: tx.meta.err != null ? JSON.stringify(tx.meta.err) : null,
      lamportsDelta: BigInt(post) - BigInt(pre),
      tokenDelta,
      decimals,
      blockTime: typeof tx.blockTime === "number" ? new Date(tx.blockTime * 1000) : null,
    };
  }

  /**
   * The wallet's total balance of `mint` across its token accounts (either token program), with
   * the accounts themselves (for closing an empty one).
   */
  async getTokenBalance(
    owner: string,
    mint: string,
  ): Promise<{
    raw: bigint;
    decimals: number | null;
    accounts: { address: string; programId: string; raw: bigint }[];
  } | null> {
    const out = await this.read<{
      value?: {
        pubkey?: string;
        account?: {
          owner?: string;
          data?: { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } };
        };
      }[];
    }>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    if (!out || !Array.isArray(out.value)) return null;
    let raw = 0n;
    let decimals: number | null = null;
    const accounts: { address: string; programId: string; raw: bigint }[] = [];
    for (const entry of out.value) {
      const amount = entry.account?.data?.parsed?.info?.tokenAmount;
      const value =
        typeof amount?.amount === "string" && /^\d+$/.test(amount.amount) ? BigInt(amount.amount) : 0n;
      raw += value;
      if (typeof amount?.decimals === "number") decimals = amount.decimals;
      if (typeof entry.pubkey === "string" && typeof entry.account?.owner === "string") {
        accounts.push({ address: entry.pubkey, programId: entry.account.owner, raw: value });
      }
    }
    return { raw, decimals, accounts };
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
