import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import type { WalletAccount } from "@wallet-standard/base";
import bs58 from "bs58";
import { ApiError, api, post } from "./api";
import { burnWallet, readyBurnWallet } from "./burn";
import { postWithTwoFactor } from "./twoFactor";
import { toBase64 } from "./burnTx";
import { shortAddress } from "./format";
import { onWalletsChanged, withTimeout } from "./wallet";

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
  /** Full Pro Mode. Always true now: a wallet without it gets no Pro state (no sell-only access). */
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
  /** Priority fee: the network's going rate (capped per speed), or the trader's own amount. */
  priorityMode: "auto" | "custom";
  /** The custom priority fee, SOL per trade. */
  customPrioritySol: number;
  /** Sender's tip, SOL; null is the speed's minimum (0.000005 Eco, 0.001 Turbo). */
  customTipSol: number | null;
  /** The buy buttons under the chart in one row or two (user ask 2026-10-18: one by default). */
  buyRows: 1 | 2;
  /** The quick-buy pill on alert and stream cards (off by default). */
  quickBuy: QuickBuySettings;
}

export interface QuickBuySettings {
  enabled: boolean;
  /** SOL per tap. */
  amountSol: number;
  position: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  size: "s" | "m" | "l";
  color: (typeof QUICK_BUY_COLORS)[number];
}

export const QUICK_BUY_COLORS = ["green", "blue", "purple", "amber", "pink", "gray"] as const;
export const QUICK_BUY_POSITIONS = ["top-right", "top-left", "bottom-right", "bottom-left"] as const;
/** Most buy buttons per row. */
export const BUY_PRESETS_PER_ROW = 5;

export const DEFAULT_QUICK_BUY: QuickBuySettings = {
  enabled: false,
  amountSol: 0.1,
  position: "top-right",
  size: "m",
  color: "green",
};

/** Each custom fee's ceiling, SOL (the API refuses more). */
export const MAX_CUSTOM_FEE_SOL = 0.01;
/** Sender's minimum tip per speed, SOL. */
export const MIN_TIP_SOL = { eco: 0.000005, turbo: 0.001 } as const;

/** The smallest Pro trade the API takes (sales of 100% aside). */
export const MIN_TRADE_SOL = 0.01;

export const DEFAULT_TRADE_SETTINGS: TradeSettings = {
  buyPresets: [0.1, 0.25, 0.5, 1],
  sellPresets: [25, 50, 100],
  slippagePct: 15,
  speed: "eco",
  mevProtect: true,
  priorityMode: "auto",
  customPrioritySol: 0.0001,
  customTipSol: null,
  buyRows: 1,
  quickBuy: DEFAULT_QUICK_BUY,
};

const SETTINGS_KEY = "ts-pro-trade-settings";

/** Read once per page, then kept here: every panel and card shares one copy (useTradeSettings). */
let current: TradeSettings | null = null;
const settingsListeners = new Set<() => void>();

export function readTradeSettings(): TradeSettings {
  current ??= parseTradeSettings(readStoredSettings());
  return current;
}

function readStoredSettings(): string | null {
  try {
    return localStorage.getItem(SETTINGS_KEY);
  } catch {
    return null;
  }
}

/** The settings as saved, with anything missing or out of range back at its default. */
export function parseTradeSettings(raw: string | null): TradeSettings {
  try {
    if (!raw) return DEFAULT_TRADE_SETTINGS;
    const s = JSON.parse(raw) as Partial<TradeSettings>;
    const buyRows = s.buyRows === 2 ? 2 : 1;
    const nums = (v: unknown, ok: (n: number) => boolean, fallback: number[], max: number) =>
      Array.isArray(v) && v.length > 0 && v.length <= max && v.every((n) => typeof n === "number" && ok(n))
        ? (v as number[])
        : fallback;
    const q = (s.quickBuy ?? {}) as Partial<QuickBuySettings>;
    return {
      buyRows,
      quickBuy: {
        enabled: q.enabled === true,
        amountSol:
          typeof q.amountSol === "number" && q.amountSol >= MIN_TRADE_SOL && q.amountSol <= 100
            ? q.amountSol
            : DEFAULT_QUICK_BUY.amountSol,
        position: QUICK_BUY_POSITIONS.includes(q.position as never)
          ? (q.position as QuickBuySettings["position"])
          : DEFAULT_QUICK_BUY.position,
        size: q.size === "s" || q.size === "l" ? q.size : "m",
        color: QUICK_BUY_COLORS.includes(q.color as never)
          ? (q.color as QuickBuySettings["color"])
          : DEFAULT_QUICK_BUY.color,
      },
      buyPresets: nums(
        s.buyPresets,
        (n) => n >= MIN_TRADE_SOL && n <= 100,
        DEFAULT_TRADE_SETTINGS.buyPresets,
        BUY_PRESETS_PER_ROW * buyRows,
      ),
      sellPresets: withSellAll(
        nums(s.sellPresets, (n) => n > 0 && n <= 100, DEFAULT_TRADE_SETTINGS.sellPresets, 6),
      ),
      slippagePct:
        typeof s.slippagePct === "number" && s.slippagePct >= 0.1 && s.slippagePct <= 50
          ? s.slippagePct
          : DEFAULT_TRADE_SETTINGS.slippagePct,
      speed: s.speed === "turbo" ? "turbo" : "eco",
      mevProtect: s.mevProtect !== false,
      priorityMode: s.priorityMode === "custom" ? "custom" : "auto",
      customPrioritySol:
        typeof s.customPrioritySol === "number" &&
        s.customPrioritySol >= 0 &&
        s.customPrioritySol <= MAX_CUSTOM_FEE_SOL
          ? s.customPrioritySol
          : DEFAULT_TRADE_SETTINGS.customPrioritySol,
      customTipSol:
        typeof s.customTipSol === "number" && s.customTipSol > 0 && s.customTipSol <= MAX_CUSTOM_FEE_SOL
          ? s.customTipSol
          : null,
    };
  } catch {
    return DEFAULT_TRADE_SETTINGS;
  }
}

/**
 * The trading disclaimer (user ask 2026-10-18): each wallet accepts it once in this browser before
 * its first trade. With storage blocked it is asked again on each page load, which still means at
 * least once.
 */
const DISCLAIMER_KEY = "ts-pro-trade-disclaimer-v1";

export function disclaimerAccepted(wallet: string): boolean {
  try {
    const raw = localStorage.getItem(DISCLAIMER_KEY);
    const wallets: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(wallets) && wallets.includes(wallet);
  } catch {
    return false;
  }
}

export function acceptDisclaimer(wallet: string): void {
  try {
    const raw = localStorage.getItem(DISCLAIMER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const wallets = Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === "string") : [];
    if (!wallets.includes(wallet))
      localStorage.setItem(DISCLAIMER_KEY, JSON.stringify([...wallets, wallet].slice(-20)));
  } catch {
    // Blocked storage: accepted for this page load only.
  }
}

export function saveTradeSettings(s: TradeSettings): void {
  current = s;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Blocked storage: the settings hold for this page load.
  }
  for (const l of settingsListeners) l();
}

/** The trading settings, re-rendering on any change (Settings tab, Trade panel, another tab). */
export function useTradeSettings(): TradeSettings {
  return useSyncExternalStore((l) => {
    settingsListeners.add(l);
    // Another browser tab saved: read it again.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SETTINGS_KEY) return;
      current = parseTradeSettings(e.newValue);
      l();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      settingsListeners.delete(l);
      window.removeEventListener("storage", onStorage);
    };
  }, readTradeSettings);
}

/** The settings' custom fees as the API takes them: lamport strings, left out when not set. */
export function feeParams(s: TradeSettings): { priorityFeeLamports?: string; tipLamports?: string } {
  const lamports = (sol: number) => String(Math.round(sol * 1e9));
  return {
    ...(s.priorityMode === "custom" ? { priorityFeeLamports: lamports(s.customPrioritySol) } : {}),
    // A tip under the speed's minimum goes as the minimum (Turbo's is higher than Eco's).
    ...(s.customTipSol !== null
      ? { tipLamports: lamports(Math.max(s.customTipSol, MIN_TIP_SOL[s.speed])) }
      : {}),
  };
}

/** GET /pro/trade/fee: what one trade would pay the network now, lamports. */
export interface FeeEstimate {
  priorityFeeLamports: string;
  tipLamports: string;
  baseFeeLamports: string;
  platformFeeLamports: string;
}

/** GET /pro/trade/costs: the rest of what a buy of refLamports costs, beyond the network. */
export interface SwapCostEstimate {
  refLamports: string;
  /** The coin's own transfer tax (Token-2022), basis points of every buy and sell; null when unread. */
  transferFeeBps: number | null;
  /** The pools' LP, curve and protocol fees on the route, basis points; null when unknown. */
  poolFeeBps: number | null;
  venues: string[];
  /** Price impact of the reference buy, percent. */
  priceImpactPct: number | null;
  /** The token account's rent on a first buy, refunded when it is closed; "0" when the wallet has one. */
  accountRentLamports: string;
}

/** The expected network fee for a trade on `mint` with these settings, re-read every 20s. */
export function useFeeEstimate(mint: string, settings: TradeSettings): FeeEstimate | null {
  const [fee, setFee] = useState<FeeEstimate | null>(null);
  const params = new URLSearchParams({ mint, speed: settings.speed, ...feeParams(settings) }).toString();
  useEffect(() => {
    let live = true;
    const load = () =>
      api<FeeEstimate>(`/pro/trade/fee?${params}`)
        .then((f) => live && setFee(f))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 20_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [params]);
  return fee;
}

/**
 * The swap costs of a buy of `refSol` on `mint` (GET /pro/trade/costs), re-read every minute: a
 * Jupiter quote each, so quoted on the first buy button rather than every typed amount.
 */
export function useSwapCosts(mint: string, refSol: number): SwapCostEstimate | null {
  const [costs, setCosts] = useState<SwapCostEstimate | null>(null);
  const ref = String(Math.round(refSol * 1e9));
  useEffect(() => {
    let live = true;
    const load = () =>
      api<SwapCostEstimate>(`/pro/trade/costs?${new URLSearchParams({ mint, refLamports: ref })}`)
        .then((c) => live && setCosts(c))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [mint, ref]);
  return costs;
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
  const w = await readyBurnWallet(owner);
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

/** Whether this browser has a wallet that can sign `owner`'s trades (what accountFor will find). */
export function canSignTrades(owner: string): boolean {
  const w = burnWallet(owner);
  return !!w && SolanaSignTransaction in w.wallet.features;
}

/**
 * canSignTrades, kept current as wallet extensions load, register or come back from being unlocked.
 * False on a venue that can't sign at all, such as a phone signed in by QR from a desktop (user ask
 * 2026-10-18: no Trade section where a trade couldn't be signed).
 */
export function useCanSignTrades(owner: string | null): boolean {
  const [can, setCan] = useState(() => !!owner && canSignTrades(owner));
  useEffect(() => {
    if (!owner) return setCan(false);
    const refresh = () => setCan(canSignTrades(owner));
    refresh();
    const off = onWalletsChanged(refresh);
    // Some extensions announce themselves a beat after the page.
    const late = setTimeout(refresh, 2_000);
    window.addEventListener("focus", refresh);
    return () => {
      off();
      clearTimeout(late);
      window.removeEventListener("focus", refresh);
    };
  }, [owner]);
  return can;
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

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** The runtime's unit limit when a transaction sets none. */
const DEFAULT_UNIT_LIMIT = 200_000n;
/** The most a build may pay in priority fee, and in Sender tips, each: the API's custom-fee ceiling. */
const MAX_FEE_LAMPORTS = BigInt(Math.round(MAX_CUSTOM_FEE_SOL * 1e9));
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/**
 * Jupiter's exact-in routes the API builds, and where each keeps the account the output lands in.
 * Their arguments end in in_amount (u64), quoted_out (u64), slippage_bps (u16), platform_fee_bps (u8).
 */
const JUPITER_ROUTES = new Map([
  ["229,23,203,151,122,227,173,42", 3], // route: user_destination_token_account
  ["193,32,155,51,65,214,156,129", 6], // shared_accounts_route: destination_token_account
]);
/** Pump.fun v3: buy_exact_quote_in_v3 (sol in, min tokens) and sell_v3 (tokens, min sol). */
const PUMP_BUY = "225,247,80,30,213,179,132,136";
const PUMP_SELL = "28,146,222,119,38,196,105,213";

/** The trade the wallet asked for, which the build must be. */
export interface TradeCheck {
  side: "buy" | "sell";
  /** Lamports to spend (buy) or raw tokens to sell. */
  amount: bigint;
  /** Selling the whole balance: the API reads it fresh, so the amount may differ. */
  all?: boolean;
  slippageBps: number;
  /** The wallet's wrapped-SOL accounts and its accounts for the coin (solanaPda.ts). */
  ownWrappedSol: string[];
  ownCoinAccounts: string[];
}

/**
 * A second look at the API's build before the wallet is asked to sign it, so a compromised API
 * or a tampered response can't slip in something else. The same static rules as the API's guard
 * (packages/core/src/trading/txGuard.ts): one signer and it is this wallet; only the swap's
 * programs; SOL leaves the wallet only as Sender's tip or into its own wrapped-SOL account; token
 * instructions only wrap, unwrap to the wallet, or open the wallet's own accounts (never Approve,
 * Transfer or SetAuthority); fees within their ceilings; and every account those instructions
 * move funds with written in the message itself, not a lookup table.
 *
 * And it must be the trade asked for (`trade`): exactly one swap, on the side asked, for the
 * amount asked, with no platform fee, no wider slippage than set, a minimum above zero, its
 * output landing in the wallet's own account, and no more SOL wrapped than a buy spends. What a
 * route's quote should be the browser can't know: the API's guard and simulation check that.
 * Returns why it isn't fine, or null. (The wallet's own preview still shows what it does.)
 */
export function tradeProblem(tx: Uint8Array, owner: string, trade: TradeCheck): string | null {
  const own = new Set([owner, ...trade.ownWrappedSol]);
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
    const take = (n: number) => {
      if (at + n > tx.length) throw new Error("short");
      const out = tx.subarray(at, at + n);
      at += n;
      return out;
    };
    const signatures = shortVec();
    take(64 * signatures);
    if ((tx[at] ?? 0) & 0x80) at++; // versioned message
    const required = tx[at];
    at += 3;
    const keyCount = shortVec();
    const keys: string[] = [];
    for (let i = 0; i < keyCount; i++) keys.push(bs58.encode(take(32)));
    take(32); // blockhash
    if (signatures !== 1 || required !== 1) return "it needs a signer besides your wallet";
    if (keys[0] !== owner) return "your wallet isn't the one paying for it";

    let tips = 0n;
    let wrapped = 0n;
    let swaps = 0;
    let unitLimit = DEFAULT_UNIT_LIMIT;
    let unitPrice = 0n;
    const ixCount = shortVec();
    for (let i = 0; i < ixCount; i++) {
      const program = keys[tx[at++]!];
      if (!program || !TRADE_PROGRAMS.has(program)) return "it calls a program a swap doesn't need";
      const accounts = Array.from(take(shortVec()));
      const d = take(shortVec());
      const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
      // An account it moves funds with: written in the message, never from a lookup table.
      const acct = (n: number) => {
        const index = accounts[n];
        if (index === undefined || index >= keys.length) throw new Error("lookup");
        return keys[index]!;
      };
      if (program === COMPUTE_BUDGET) {
        if (d[0] === 2 && d.length >= 5) unitLimit = BigInt(view.getUint32(1, true));
        else if (d[0] === 3 && d.length >= 9) unitPrice = view.getBigUint64(1, true);
        continue;
      }
      if (program === SYSTEM) {
        const tag = d.length >= 4 ? view.getUint32(0, true) : -1;
        if (tag === 2 && d.length >= 12 && acct(0) === owner) {
          const to = acct(1);
          if (own.has(to)) {
            wrapped += view.getBigUint64(4, true);
            continue;
          }
          if (SENDER_TIP_ACCOUNTS.has(to)) {
            tips += view.getBigUint64(4, true);
            continue;
          }
          return "it sends SOL from your wallet to an account that isn't yours";
        }
        if (
          tag === 0 &&
          d.length >= 52 &&
          acct(0) === owner &&
          TOKEN_PROGRAMS.has(bs58.encode(d.subarray(20, 52))) &&
          view.getBigUint64(4, true) <= MAX_FEE_LAMPORTS // rent for a token account, returned on close
        )
          continue;
        return "it has a System instruction a swap doesn't need";
      }
      if (TOKEN_PROGRAMS.has(program)) {
        const tag = d[0];
        if (tag === 17) continue; // SyncNative
        if (tag === 9 && acct(1) === owner && acct(2) === owner) continue; // CloseAccount, to the wallet
        if (tag === 18 && d.length >= 33 && bs58.encode(d.subarray(1, 33)) === owner) continue; // InitializeAccount3
        if (tag === 1 && acct(2) === owner) continue; // InitializeAccount
        return "it has a token instruction a swap doesn't need (like an approval or a transfer)";
      }
      if (program === ATA) {
        const tag = d.length === 0 ? 0 : d[0];
        if ((tag === 0 || tag === 1) && acct(0) === owner && acct(2) === owner) continue;
        return "it opens a token account that isn't yours";
      }
      const u64At = (offset: number) => view.getBigUint64(offset, true);
      const discriminator = Array.from(d.subarray(0, 8)).join(",");
      if (program === JUPITER) {
        const destAt = JUPITER_ROUTES.get(discriminator);
        if (destAt === undefined || d.length < 8 + 19) return "it has a Jupiter step this trade doesn't need";
        swaps++;
        if (d[d.length - 1] !== 0) return "Jupiter would take a platform fee";
        if (view.getUint16(d.length - 3, true) > trade.slippageBps)
          return "it allows more slippage than you set";
        const inAmount = u64At(d.length - 19);
        if (trade.all ? inAmount <= 0n : inAmount !== trade.amount)
          return "its amount isn't the one you asked for";
        const dest = acct(destAt);
        if (!(trade.side === "buy" ? trade.ownCoinAccounts : trade.ownWrappedSol).includes(dest))
          return "what it buys wouldn't land in your wallet";
        continue;
      }
      if (program === PUMP) {
        const side = discriminator === PUMP_BUY ? "buy" : discriminator === PUMP_SELL ? "sell" : null;
        if (!side || d.length < 24) return "it has a Pump.fun step this trade doesn't need";
        swaps++;
        if (side !== trade.side) return "it's a different trade from the one you asked for";
        const amount = u64At(8);
        if (trade.all && side === "sell" ? amount <= 0n : amount !== trade.amount)
          return "its amount isn't the one you asked for";
        if (u64At(16) <= 0n) return "it has no minimum, so any price would do";
        continue;
      }
    }
    if (swaps !== 1) return "it isn't exactly one swap";
    // SOL wrapped for the swap: no more than a buy spends, none at all for a sale.
    if (wrapped > (trade.side === "buy" ? trade.amount : 0n))
      return "it moves more SOL than you asked to spend";
    if (tips === 0n) return "it doesn't go through Helius Sender";
    if (tips > MAX_FEE_LAMPORTS) return "its Sender tip is over 0.01 SOL";
    if ((unitPrice * unitLimit) / 1_000_000n > MAX_FEE_LAMPORTS) return "its priority fee is over 0.01 SOL";
    return null;
  } catch (e) {
    return e instanceof Error && e.message === "lookup"
      ? "an account it moves funds with comes from a lookup table"
      : "it couldn't be read";
  }
}

/** The API's one trade per 5 seconds per wallet (sales of 100% exempt), checked here first. */
export const TRADE_COOLDOWN_MS = 5_000;
/**
 * When each wallet last sent a trade from this page: the Trade panels, quick buy and the access
 * buy alike, so a quick buy straight after a panel trade says "wait" instead of a round trip.
 */
const lastSentAt = new Map<string, number>();

/** Milliseconds until `owner` may trade again here; 0 when it may now. */
export function tradeCooldownLeft(owner: string, now = Date.now()): number {
  return Math.max(0, (lastSentAt.get(owner) ?? -Infinity) + TRADE_COOLDOWN_MS - now);
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
  // Two-factor, when the user chose it for this side (or this size): the API asks, we prompt.
  const built = await postWithTwoFactor<BuiltTrade>("/pro/trade/build", {
    mint: input.mint,
    side: input.side,
    amount: input.amount.toString(),
    slippageBps: Math.round(input.settings.slippagePct * 100),
    speed: input.settings.speed,
    ...feeParams(input.settings),
    ...(input.all ? { all: true } : {}),
  });
  const unsigned = fromBase64(built.transaction);
  const { ownTokenAccounts, ownWrappedSolAccounts } = await import("./solanaPda");
  const problem = tradeProblem(unsigned, input.owner, {
    side: input.side,
    amount: input.amount,
    all: input.all,
    slippageBps: Math.round(input.settings.slippagePct * 100),
    ownWrappedSol: ownWrappedSolAccounts(input.owner),
    ownCoinAccounts: ownTokenAccounts(input.owner, input.mint),
  });
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
  lastSentAt.set(input.owner, Date.now());
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

/**
 * The sell presets always end with 100%: the Trade panel has no other way to close a position, and
 * a partial sale under 0.01 SOL is refused, so a list without it could strand a small position.
 */
export function withSellAll(presets: number[]): number[] {
  if (presets.some((p) => p >= 100)) return presets;
  return [...presets.slice(0, 5), 100];
}
