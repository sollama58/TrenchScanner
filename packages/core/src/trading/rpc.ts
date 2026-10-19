import { fetchJson } from "../datasources/httpClient.js";
import { resolveSolanaRpcUrl, type SolanaRpcOptions } from "../subscription/solanaRpc.js";
import type { GuardRpc, ParsedAccountState, WalletTokenAccount } from "./txGuard.js";
import { PROGRAM } from "./txGuard.js";
import { decodeMessage, parseWireTransaction } from "./transaction.js";

import { JITO_TIP_ACCOUNTS } from "./jitoTips.js";

export { JITO_TIP_ACCOUNTS };

export const DEFAULT_JITO_BLOCK_ENGINE_URL = "https://mainnet.block-engine.jito.wtf";

/** Whether a signed transaction tips Jito (names a tip account in its own keys). */
export function tipsJito(base64Tx: string): boolean {
  try {
    const keys = decodeMessage(parseWireTransaction(Buffer.from(base64Tx, "base64")).message).staticKeys;
    return keys.some((k) => JITO_TIP_ACCOUNTS.has(k));
  } catch {
    return false;
  }
}

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

export interface TokenBalanceEntry {
  /** The token account's place in the transaction's accounts (and in pre/postBalances). */
  accountIndex?: number;
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

/** Where a signature stands: landed (ok or failed), or not seen. */
export type SignatureStatus = { seen: false } | { seen: true; confirmed: boolean; error: string | null };

/** One coin a wallet holds: its raw balance across the wallet's token accounts. */
export interface WalletBalance {
  mint: string;
  raw: bigint;
  decimals: number;
}

/** A mint account's authorities and Token-2022 extensions. */
export interface MintInfo {
  /** The token program that owns it. */
  program: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Token-2022 extension names, as the RPC's jsonParsed encoding names them. */
  extensions: string[];
  /** Absent when the RPC didn't say. */
  decimals?: number;
  /** A Token-2022 transfer fee, basis points (the higher of its current and scheduled rates); 0 without one. */
  transferFeeBps?: number;
}

/** A transaction as getTransaction's "json" encoding returns it (the fields read here). */
export interface RawTransaction {
  blockTime?: number | null;
  meta?: {
    err: unknown;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
  } | null;
  transaction?: { message?: { accountKeys?: string[] } };
}

export class TradingRpc implements GuardRpc {
  readonly url: string;
  /** A second endpoint (TRADING_BACKUP_RPC_URL): asked when the first gives no answer, and sent every transaction too. */
  readonly backupUrl: string | null;

  /** Jito's block engine, for the transactions that tip it. */
  readonly jitoUrl: string;

  constructor(options: SolanaRpcOptions & { backupUrl?: string; jitoUrl?: string } = {}) {
    this.url = resolveSolanaRpcUrl(options);
    this.backupUrl = options.backupUrl && options.backupUrl !== this.url ? options.backupUrl : null;
    this.jitoUrl = (options.jitoUrl || DEFAULT_JITO_BLOCK_ENGINE_URL).replace(/\/$/, "");
  }

  /**
   * One JSON-RPC call. Throws RpcError when the node answered with an error; null on no answer.
   * With a backup endpoint, a call the first one didn't answer (down, timed out, rate limited, out
   * of credits) is asked of the backup before giving up. The first endpoint then gets at most
   * PRIMARY_TIMEOUT_MS and no retry of its own, so a hung node fails over in seconds: the backup
   * is the retry.
   */
  protected async call<T>(
    method: string,
    params: unknown[],
    timeoutMs = 15_000,
    retries = 1,
  ): Promise<T | null> {
    if (!this.backupUrl) return (await this.callAt<T>(this.url, method, params, timeoutMs, retries)).result;
    const first = await this.callAt<T>(this.url, method, params, Math.min(timeoutMs, PRIMARY_TIMEOUT_MS), 0);
    if (first.answered) return first.result;
    return (await this.callAt<T>(this.backupUrl, method, params, timeoutMs, retries)).result;
  }

  private async callAt<T>(
    url: string,
    method: string,
    params: unknown[],
    timeoutMs: number,
    retries: number,
  ): Promise<{ answered: boolean; result: T | null }> {
    try {
      const body = await fetchJson<Envelope<T>>(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        timeoutMs,
        retries,
      });
      if (body.error) {
        // "Not now" (rate limited, out of credits) says nothing about the request: no answer, so
        // the backup is asked.
        if (isNotNowRpcError(body.error)) return { answered: false, result: null };
        throw new RpcError(method, body.error.code, body.error.message);
      }
      return { answered: true, result: body.result ?? null };
    } catch (err) {
      if (err instanceof RpcError) throw err;
      return { answered: false, result: null };
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
              decimals?: number;
              extensions?: {
                extension?: string;
                state?: {
                  newerTransferFee?: { transferFeeBasisPoints?: number };
                  olderTransferFee?: { transferFeeBasisPoints?: number };
                };
              }[];
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
      ...(typeof info.decimals === "number" ? { decimals: info.decimals } : {}),
      transferFeeBps: transferFeeBpsOf(info.extensions ?? []),
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
   * The wallet's coin balances, non-zero only, summed per mint (classic and Token-2022 accounts):
   * two getTokenAccountsByOwner reads, a credit each on Helius. Null when either read failed.
   */
  async getWalletBalances(owner: string): Promise<WalletBalance[] | null> {
    const byMint = new Map<string, WalletBalance>();
    for (const programId of [PROGRAM.token, PROGRAM.token2022]) {
      const page = await this.read<{ value?: { account?: RawAccount }[] }>("getTokenAccountsByOwner", [
        owner,
        { programId },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      if (!page || !Array.isArray(page.value)) return null;
      for (const entry of page.value) {
        const data = entry.account?.data;
        const info = data && !Array.isArray(data) ? data.parsed?.info : undefined;
        const amount = info?.tokenAmount?.amount;
        if (typeof info?.mint !== "string" || typeof amount !== "string" || !/^\d+$/.test(amount)) continue;
        const raw = BigInt(amount);
        if (raw === 0n) continue;
        const kept = byMint.get(info.mint);
        if (kept) kept.raw += raw;
        else byMint.set(info.mint, { mint: info.mint, raw, decimals: info.tokenAmount?.decimals ?? 0 });
      }
    }
    return [...byMint.values()];
  }

  /**
   * Sends a signed transaction, once - no client retry (a resend is the engine's decision, by the
   * same signature). Skips preflight: the guard simulated it a moment ago. Never throws: whether
   * it landed is for confirmation to settle, since an error reply does not prove it was not
   * forwarded. Returns the node's error text, if any, for the record.
   */
  async send(base64Tx: string): Promise<string | null> {
    // A swap that tips Jito goes to Jito's block engine alone: through an ordinary RPC it would be
    // in reach of the sandwich bots the tip is paid to avoid. Only when Jito doesn't take it does
    // it fall back to the RPCs.
    if (tipsJito(base64Tx)) {
      try {
        const out = await this.callAt<string>(
          `${this.jitoUrl}/api/v1/transactions`,
          "sendTransaction",
          [base64Tx, { encoding: "base64" }],
          10_000,
          0,
        );
        if (out.answered) return null;
      } catch {
        /* refused: try the RPCs */
      }
    }
    // To every endpoint at once: the same signed bytes can land only once, and two paths to the
    // leader beat one.
    const urls = this.backupUrl ? [this.url, this.backupUrl] : [this.url];
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const out = await this.callAt<string>(
            url,
            "sendTransaction",
            [base64Tx, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
            15_000,
            0,
          );
          return out.answered ? null : "no answer from the RPC";
        } catch (err) {
          return String(err instanceof Error ? err.message : err);
        }
      }),
    );
    return results.includes(null) ? null : results[0]!;
  }

  /**
   * Where a signature stands: landed (ok or failed), or not seen (null status). Null when unknown.
   * `searchHistory: false` asks only the node's recent status cache (the last ~150 blocks): faster,
   * and enough for a signature seconds old, but "not seen" then proves nothing about an older one.
   */
  async getSignatureStatus(
    signature: string,
    options: { searchHistory?: boolean } = {},
  ): Promise<SignatureStatus | null> {
    const out = await this.getSignatureStatuses([signature], options);
    return out ? out[0]! : null;
  }

  /** getSignatureStatus for many signatures, 256 a call; null when any call went unanswered. */
  async getSignatureStatuses(
    signatures: string[],
    options: { searchHistory?: boolean } = {},
  ): Promise<SignatureStatus[] | null> {
    const statuses: SignatureStatus[] = [];
    for (let i = 0; i < signatures.length; i += 256) {
      const page = signatures.slice(i, i + 256);
      const out = await this.read<{
        value?: ({ err: unknown; confirmationStatus?: string | null } | null)[];
      }>("getSignatureStatuses", [page, { searchTransactionHistory: options.searchHistory ?? true }]);
      if (!out?.value || out.value.length !== page.length) return null;
      for (const status of out.value) {
        if (!status) {
          statuses.push({ seen: false });
          continue;
        }
        const confirmed =
          status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized";
        statuses.push({ seen: true, confirmed, error: status.err ? JSON.stringify(status.err) : null });
      }
    }
    return statuses;
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
   * The newest signatures that touched `address` (at most `limit`), older than `before` when it
   * is given; null when unknown.
   */
  async getSignaturesForAddress(
    address: string,
    limit: number,
    before?: string,
  ): Promise<{ signature: string; blockTime: number | null; failed: boolean }[] | null> {
    const out = await this.read<{ signature?: string; blockTime?: number | null; err?: unknown }[]>(
      "getSignaturesForAddress",
      [address, { limit, commitment: "confirmed", ...(before ? { before } : {}) }],
    );
    if (!Array.isArray(out)) return null;
    return out.flatMap((e) =>
      typeof e.signature === "string"
        ? [{ signature: e.signature, blockTime: e.blockTime ?? null, failed: e.err != null }]
        : [],
    );
  }

  /**
   * A landed transaction as the RPC's "json" encoding gives it (any version: v1 messages are on
   * mainnet now, and Pump.fun's own trades use them). Null when unknown or not found.
   */
  async getTransactionJson(signature: string): Promise<RawTransaction | null> {
    return this.read<RawTransaction>("getTransaction", [
      signature,
      { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 },
    ]);
  }

  /** A mint's supply (raw units) and decimals; null when it can't be read. */
  async getTokenSupply(mint: string): Promise<{ raw: bigint; decimals: number } | null> {
    const out = await this.read<{ value?: { amount?: string; decimals?: number } }>("getTokenSupply", [
      mint,
      { commitment: "confirmed" },
    ]);
    const v = out?.value;
    if (!v || typeof v.amount !== "string" || !/^\d+$/.test(v.amount) || typeof v.decimals !== "number")
      return null;
    return { raw: BigInt(v.amount), decimals: v.decimals };
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

/** With a backup endpoint, the most a call waits on the first one before asking the backup. */
export const PRIMARY_TIMEOUT_MS = 6_000;

/**
 * A JSON-RPC error that means "not now" rather than "no": a rate limit or an exhausted plan, which
 * some providers (Helius's out-of-credits answer among them) send with HTTP 200.
 */
export function isNotNowRpcError(error: { code?: unknown; message?: unknown }): boolean {
  const message = typeof error.message === "string" ? error.message : "";
  if (error.code === -32429 || error.code === -32005) return true;
  if (error.code === -32603 && /rate/i.test(message)) return true;
  return /rate limit|max usage|credits|too many/i.test(message);
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

/** The transfer fee a mint's jsonParsed extensions set, basis points; 0 without one. */
export function transferFeeBpsOf(
  extensions: {
    extension?: string;
    state?: {
      newerTransferFee?: { transferFeeBasisPoints?: number };
      olderTransferFee?: { transferFeeBasisPoints?: number };
    };
  }[],
): number {
  const config = extensions.find((e) => e.extension === "transferFeeConfig")?.state;
  if (!config) return 0;
  const rates = [
    config.newerTransferFee?.transferFeeBasisPoints,
    config.olderTransferFee?.transferFeeBasisPoints,
  ];
  return Math.max(0, ...rates.filter((r): r is number => typeof r === "number" && Number.isFinite(r)));
}
