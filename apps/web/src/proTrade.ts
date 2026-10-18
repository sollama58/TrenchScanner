import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import type { WalletAccount } from "@wallet-standard/base";
import bs58 from "bs58";
import { ApiError, api, post } from "./api";
import { burnWallet } from "./burn";
import { toBase64 } from "./burnTx";
import { shortAddress } from "./format";
import { withTimeout } from "./wallet";

/**
 * Pro Mode trades from the token modal (user decision 2026-10-17): the API builds a swap for the
 * signed-in wallet (apps/api/src/routes/proTrade.ts), the wallet signs it here, and the API relays
 * it to Helius Sender. No fee is taken; nothing here holds or asks for a key.
 *
 * Shown only to Pro Mode wallets: the App sets the wallet below from /auth/me's isPro, and
 * everything Pro reads it, so a wallet without Pro Mode never renders, fetches or loads any of it.
 */

// ---- Who is Pro (set by App from the session) ----

/** The signed-in wallet's Pro Mode, as /auth/me said it. */
export interface ProState {
  wallet: string;
  /** Full Pro Mode (buys too); false: it may only sell what it holds. */
  pro: boolean;
  /** Dropped out of the top 250 holders: when Pro Mode ends (ms). */
  graceEndsAt: number | null;
  /** The grace is because the holder scans stopped, not because the wallet left the top 250. */
  graceUnconfirmed: boolean;
}

let proState: ProState | null = null;
const listeners = new Set<() => void>();

export function setProState(next: ProState | null): void {
  if (
    next === proState ||
    (next &&
      proState &&
      next.wallet === proState.wallet &&
      next.pro === proState.pro &&
      next.graceEndsAt === proState.graceEndsAt &&
      next.graceUnconfirmed === proState.graceUnconfirmed)
  )
    return;
  proState = next;
  for (const l of listeners) l();
}

/** The Pro state from a session's user, or null when the trade system stays hidden for it. */
export function proStateOf(user: {
  walletAddress: string;
  isPro?: boolean;
  proMode?: { canClose: boolean; graceEndsAt?: string; graceReason?: string };
}): ProState | null {
  const grace = user.proMode?.graceEndsAt ? Date.parse(user.proMode.graceEndsAt) : NaN;
  if (user.isPro)
    return {
      wallet: user.walletAddress,
      pro: true,
      graceEndsAt: Number.isFinite(grace) ? grace : null,
      graceUnconfirmed: Number.isFinite(grace) && user.proMode?.graceReason === "unconfirmed",
    };
  if (user.proMode?.canClose)
    return { wallet: user.walletAddress, pro: false, graceEndsAt: null, graceUnconfirmed: false };
  return null;
}

function useProStore(): ProState | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => proState,
  );
}

/**
 * The signed-in wallet's Pro state, or null for a wallet that never had Pro Mode. A grace period
 * that has run out here reads as close-only at once (the API decides the same on its own).
 */
export function useProState(): ProState | null {
  const s = useProStore();
  if (s?.pro && s.graceEndsAt !== null && s.graceEndsAt <= Date.now())
    return { ...s, pro: false, graceEndsAt: null, graceUnconfirmed: false };
  return s;
}

/** The signed-in wallet when it has, or had, Pro Mode; null otherwise. */
export function useProWallet(): string | null {
  return useProStore()?.wallet ?? null;
}

/** "5h 20m", "45m": what's left of a grace period. */
export function graceLeftText(endsAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.ceil((endsAt - now) / 60_000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

// ---- The trader's settings (this browser only) ----

export interface TradeSettings {
  /** Buy buttons, in SOL. */
  buyPresets: number[];
  /** Sell buttons, in percent of the position. */
  sellPresets: number[];
  slippagePct: number;
  /** eco: Sender's SWQOS path, a 0.000005 SOL tip. turbo: every path, 0.001 SOL. */
  speed: "eco" | "turbo";
  mevProtect: boolean;
}

export const DEFAULT_TRADE_SETTINGS: TradeSettings = {
  buyPresets: [0.1, 0.25, 0.5, 1],
  sellPresets: [25, 50, 100],
  slippagePct: 15,
  speed: "eco",
  mevProtect: true,
};

const SETTINGS_KEY = "ts-pro-trade-settings";

export function readTradeSettings(): TradeSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_TRADE_SETTINGS;
    const s = JSON.parse(raw) as Partial<TradeSettings>;
    const nums = (v: unknown, ok: (n: number) => boolean, fallback: number[]) =>
      Array.isArray(v) && v.length > 0 && v.length <= 6 && v.every((n) => typeof n === "number" && ok(n))
        ? (v as number[])
        : fallback;
    return {
      buyPresets: nums(s.buyPresets, (n) => n > 0 && n <= 100, DEFAULT_TRADE_SETTINGS.buyPresets),
      sellPresets: nums(s.sellPresets, (n) => n > 0 && n <= 100, DEFAULT_TRADE_SETTINGS.sellPresets),
      slippagePct:
        typeof s.slippagePct === "number" && s.slippagePct >= 0.1 && s.slippagePct <= 50
          ? s.slippagePct
          : DEFAULT_TRADE_SETTINGS.slippagePct,
      speed: s.speed === "turbo" ? "turbo" : "eco",
      mevProtect: s.mevProtect !== false,
    };
  } catch {
    return DEFAULT_TRADE_SETTINGS;
  }
}

export function saveTradeSettings(s: TradeSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Blocked storage: the settings hold for this page load.
  }
}

// ---- The wallet's position in a coin ----

/** GET /pro/trade/:mint/position. Amounts are decimal strings (u64s never go through a float). */
export interface PositionResponse {
  wallet: string;
  mint: string;
  decimals: number | null;
  balance: string;
  supply: string | null;
  solUsd: number | null;
  trades: {
    signature: string;
    t: number;
    side: "buy" | "sell" | "in" | "out";
    lamports: string;
    tokens: string;
  }[];
  historyUnavailable: boolean;
  truncated: boolean;
}

const POSITION_POLL_MS = 15_000;

/** The Pro wallet's position in `mint`, polled while `mint` is set (null: not Pro, or no modal). */
export function usePosition(mint: string | null): {
  data: PositionResponse | null;
  error: Error | null;
  reload: () => void;
} {
  const [data, setData] = useState<PositionResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!mint) return;
    const mine = ++seq.current;
    api<PositionResponse>(`/pro/trade/${encodeURIComponent(mint)}/position`)
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      });
  }, [mint]);
  useEffect(() => {
    setData(null);
    setError(null);
    if (!mint) return;
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POSITION_POLL_MS);
    return () => {
      clearInterval(timer);
      seq.current++;
    };
  }, [mint, load]);
  return { data, error, reload: load };
}

/** What the position adds up to, in SOL and the coin's market cap terms. */
export interface PositionSummary {
  /** Tokens held, in whole tokens. */
  held: number;
  /** Share of supply held (0..1); null without a supply. */
  share: number | null;
  /** SOL spent on buys and got back from sales (fees and rent included). */
  solIn: number;
  solOut: number;
  /** The position's value now in SOL, from the chart's latest market cap; null when it can't be priced. */
  valueSol: number | null;
  /** Value plus what came back, less what went in, and that as a share of what went in. */
  pnlSol: number | null;
  pnlPct: number | null;
  /** The average market cap the held tokens were bought at (USD), by the buys' own prices. */
  entryMcap: number | null;
  buys: number;
  sells: number;
}

export function summarizePosition(p: PositionResponse, nowMcapUsd: number | null): PositionSummary {
  const dec = p.decimals ?? 6;
  const scale = 10 ** dec;
  const held = Number(BigInt(p.balance)) / scale;
  const supply = p.supply ? Number(BigInt(p.supply)) / scale : null;
  let solIn = 0;
  let solOut = 0;
  let boughtTokens = 0;
  let buys = 0;
  let sells = 0;
  for (const t of p.trades) {
    const lamports = Number(BigInt(t.lamports)) / 1e9;
    if (t.side === "buy") {
      solIn += -lamports;
      boughtTokens += Number(BigInt(t.tokens)) / scale;
      buys++;
    } else if (t.side === "sell") {
      solOut += lamports;
      sells++;
    }
  }
  const share = supply && supply > 0 ? held / supply : null;
  const valueSol =
    share !== null && nowMcapUsd !== null && p.solUsd
      ? (share * nowMcapUsd) / p.solUsd
      : held === 0
        ? 0
        : null;
  // Without the whole history (older trades left out) the cost is unknown, and so is the PnL.
  const pnlSol = valueSol !== null && solIn > 0 && !p.truncated ? valueSol + solOut - solIn : null;
  const pnlPct = pnlSol !== null && solIn > 0 ? pnlSol / solIn : null;
  // SOL per token paid across the buys, as a market cap: the line the chart draws as "Entry".
  const entryMcap =
    boughtTokens > 0 && supply && p.solUsd ? (solIn / boughtTokens) * supply * p.solUsd : null;
  return { held, share, solIn, solOut, valueSol, pnlSol, pnlPct, entryMcap, buys, sells };
}

// ---- Trading ----

export interface BuiltTrade {
  transaction: string;
  lastValidBlockHeight: number;
  route: "jupiter" | "pump";
  quotedOut: string;
  minOut: string;
  tipLamports: string;
  priorityFeeLamports: string;
}

export type TradeStage = "building" | "signing" | "sending" | "confirming";

export class TradeError extends Error {
  constructor(
    message: string,
    /** Set once the trade went out: it may still land, so check before trading again. */
    readonly signature?: string,
  ) {
    super(message);
  }
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function accountFor(owner: string): Promise<{
  account: WalletAccount;
  sign: SolanaSignTransactionFeature[typeof SolanaSignTransaction];
  name: string;
}> {
  const w = burnWallet(owner);
  const signer = w
    ? (w.wallet.features as Partial<SolanaSignTransactionFeature>)[SolanaSignTransaction]
    : undefined;
  if (!w || !signer)
    throw new TradeError(
      `Open this in the browser with the wallet you signed in with (${shortAddress(owner)}): trades are signed by it.`,
    );
  let account = w.wallet.accounts.find((a) => a.address === owner);
  if (!account) {
    const connect = (w.wallet.features as Partial<StandardConnectFeature>)[StandardConnect];
    const { accounts } = connect ? await withTimeout(connect.connect(), "connect") : { accounts: [] };
    account = accounts.find((a) => a.address === owner);
  }
  if (!account)
    throw new TradeError(`Switch ${w.name} to ${shortAddress(owner)}, the wallet you signed in with.`);
  return { account, sign: signer, name: w.name };
}

/** The programs a Pro trade may call at its top level (the API's guard allows the same). */
const TRADE_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
]);
/** Helius Sender's tip accounts (packages/core/src/trading/sender.ts). */
const SENDER_TIP_ACCOUNTS = new Set([
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
]);

/**
 * A second look at the API's build before the wallet is asked to sign it, so a compromised API
 * or a tampered response can't slip in something else: one signer and it is this wallet, only
 * the swap's programs at the top level, and Sender's tip. Returns why it isn't, or null.
 * (The wallet's own preview still shows what it does.)
 */
export function tradeProblem(tx: Uint8Array, owner: string): string | null {
  try {
    let at = 0;
    const shortVec = () => {
      let len = 0;
      for (let shift = 0; ; shift += 7) {
        const b = tx[at++];
        if (b === undefined || shift > 14) throw new Error("bad length");
        len |= (b & 0x7f) << shift;
        if (!(b & 0x80)) return len;
      }
    };
    const signatures = shortVec();
    at += 64 * signatures;
    if ((tx[at] ?? 0) & 0x80) at++; // versioned message
    const required = tx[at];
    at += 3;
    const keyCount = shortVec();
    const keys: string[] = [];
    for (let i = 0; i < keyCount; i++, at += 32) keys.push(bs58.encode(tx.subarray(at, at + 32)));
    at += 32; // blockhash
    if (signatures !== 1 || required !== 1) return "it needs a signer besides your wallet";
    if (keys[0] !== owner) return "your wallet isn't the one paying for it";
    const ixCount = shortVec();
    for (let i = 0; i < ixCount; i++) {
      const program = keys[tx[at++]!];
      if (!program || !TRADE_PROGRAMS.has(program)) return "it calls a program a swap doesn't need";
      // Read each length first: `at += shortVec()` would add it to `at` as it was before the read.
      const accounts = shortVec();
      at += accounts;
      const data = shortVec();
      at += data;
    }
    if (!keys.some((k) => SENDER_TIP_ACCOUNTS.has(k))) return "it doesn't go through Helius Sender";
    return null;
  } catch {
    return "it couldn't be read";
  }
}

const STATUS_POLL_MS = 1_200;
const CONFIRM_GIVE_UP_MS = 90_000;

/**
 * One trade, start to finish: build (the API checks it by simulation), sign in the wallet, send
 * through Sender, then wait for it to land. Resolves with the signature once confirmed.
 */
export async function runTrade(
  input: {
    owner: string;
    mint: string;
    side: "buy" | "sell";
    amount: bigint;
    /** A sale of the whole balance, as the chain has it when the trade is built. */
    all?: boolean;
    settings: TradeSettings;
  },
  onStage: (stage: TradeStage, built?: BuiltTrade) => void,
): Promise<string> {
  // The wallet first: if it isn't here there's no point building anything.
  const { account, sign, name } = await accountFor(input.owner);
  onStage("building");
  const built = await post<BuiltTrade>("/pro/trade/build", {
    mint: input.mint,
    side: input.side,
    amount: input.amount.toString(),
    slippageBps: Math.round(input.settings.slippagePct * 100),
    speed: input.settings.speed,
    ...(input.all ? { all: true } : {}),
  });
  const unsigned = fromBase64(built.transaction);
  const problem = tradeProblem(unsigned, input.owner);
  if (problem) throw new TradeError(`The trade built for you looks wrong (${problem}), so it wasn't signed.`);
  onStage("signing", built);
  const [signed] = await withTimeout(
    sign.signTransaction({ account, transaction: unsigned, chain: "solana:mainnet" }),
    "sign",
  );
  if (!signed?.signedTransaction) throw new TradeError(`${name} returned no signed transaction`);
  const bytes = Uint8Array.from(signed.signedTransaction);
  // Its signature, known from here on (one signer: the 64 bytes after the count), so anything
  // that goes wrong past this point can say which transaction to check before trading again.
  const signature = bytes.length >= 65 && bytes[0] === 1 ? bs58.encode(bytes.subarray(1, 65)) : undefined;
  onStage("sending", built);
  let sent: { signature: string };
  try {
    sent = await post<{ signature: string }>("/pro/trade/send", {
      transaction: toBase64(bytes),
      speed: input.settings.speed,
      mevProtect: input.settings.mevProtect,
    });
  } catch (e) {
    // The API refused it before Sender, or Sender refused it: nothing went out. Only the API's own
    // word counts (a proxy's 502 during a restart could follow a send).
    if (
      e instanceof ApiError &&
      ((e.body as { notSent?: unknown } | null)?.notSent === true || [401, 403, 404].includes(e.status))
    )
      throw e;
    // Anything else (the connection dropped, the API timed out) may have sent it.
    throw new TradeError(
      "Lost touch with the server while sending. It may still land: check your wallet before trading again.",
      signature,
    );
  }
  onStage("confirming", built);
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, STATUS_POLL_MS));
    const s = await api<{ state: string; error?: string }>(
      `/pro/trade/status/${encodeURIComponent(sent.signature)}`,
    ).catch(() => ({ state: "unknown" }) as { state: string; error?: string });
    if (s.state === "confirmed") return sent.signature;
    if (s.state === "failed")
      throw new TradeError(
        `The trade failed on chain${s.error ? ` (${s.error})` : ""}. Nothing was bought or sold.`,
      );
    if (s.state === "expired")
      throw new TradeError("The trade didn't land in time and has expired. Nothing changed.");
    if (Date.now() - started > CONFIRM_GIVE_UP_MS)
      throw new TradeError(
        "Still waiting on the chain. Check your wallet before trading again.",
        sent.signature,
      );
  }
}
