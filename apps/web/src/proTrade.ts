import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import type { WalletAccount } from "@wallet-standard/base";
import bs58 from "bs58";
import { ApiError, api, post } from "./api";
import { burnWallet, readyBurnWallet } from "./burn";
import { withTwoFactor } from "./twoFactor";
import { toBase64 } from "./burnTx";
import { shortAddress } from "./format";
import { onWalletsChanged, withTimeout } from "./wallet";
import { PRIVY_WALLET_NAME, privyControls } from "./privyBridge";
import { syncedSection } from "./syncedPrefs";

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

// ---- The trader's settings (synced to the account) ----

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
  /**
   * Live: a coin the wallet holds shows on Cards and Scope whatever the viewer's filters say (user
   * ask 2026-10-19: on by default). heldTokens.ts.
   */
  alwaysShowHeld: boolean;
}

export interface QuickBuySettings {
  enabled: boolean;
  /** SOL per tap; 0 is a blank amount, and the pill stays hidden until one is set. */
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
  amountSol: 0,
  position: "top-right",
  size: "m",
  color: "green",
};

/** A quick-buy amount the API takes; anything else (blank, 0, out of range) leaves the pill hidden. */
export function quickBuyAmountOk(v: unknown): v is number {
  return typeof v === "number" && v >= MIN_TRADE_SOL && v <= 100;
}

/**
 * Whether cards show the quick-buy pill (user ask 2026-10-19): switched on and with an amount set,
 * so it's hidden by default and whenever the amount field is blank or zero.
 */
export function quickBuyShown(q: QuickBuySettings): boolean {
  return q.enabled && quickBuyAmountOk(q.amountSol);
}

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
  alwaysShowHeld: true,
};

const SETTINGS_KEY = "ts-pro-trade-settings";

/**
 * One copy for every panel and card (useTradeSettings), kept in this browser and synced to the
 * account (syncedPrefs.ts; apps/api/src/userPrefs.ts has the same names and bounds).
 */
export const tradeSettingsSync = syncedSection<TradeSettings>({
  section: "trade",
  storageKey: SETTINGS_KEY,
  defaults: DEFAULT_TRADE_SETTINGS,
  parse: (raw) => parseTradeSettings(raw == null ? null : JSON.stringify(raw)),
});

export function readTradeSettings(): TradeSettings {
  return tradeSettingsSync.get();
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
      alwaysShowHeld: s.alwaysShowHeld !== false,
      quickBuy: {
        enabled: q.enabled === true,
        amountSol: quickBuyAmountOk(q.amountSol) ? q.amountSol : DEFAULT_QUICK_BUY.amountSol,
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
  tradeSettingsSync.set(s);
}

/** The trading settings, re-rendering on any change (Customize, the Trade panel, another tab or device). */
export function useTradeSettings(): TradeSettings {
  return tradeSettingsSync.use();
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
  /** The Sacrifice's SOL value while it is on and the wallet pays, else "0". */
  platformFeeLamports: string;
  sacrifice?: SacrificeView;
  /**
   * Helius Sender isn't answering the API just now: trades with MEV Protect off still go out
   * through the RPC; protected ones may expire. Absent from older API builds.
   */
  senderDown?: boolean;
}

/**
 * The Sacrifice on a trade (apps/api/src/sacrificeQuote.ts sacrificeView): a 0.2% fee paid from
 * burned credits by wallets below the free cut-off. "off": nothing worked out; "shadow": worked
 * out, never taken; "on": taken.
 */
export interface SacrificeView {
  mode: "off" | "shadow" | "on";
  pays: boolean;
  reason: "admin" | "grant" | "access" | "holder" | "below_cutoff" | "moved_bag" | null;
  rank: number | null;
  /** Credits it costs, rounded up to hundredths; null when it pays nothing or can't be priced. */
  credits: number | null;
  lamports: string | null;
  asdfRaw: string | null;
  asdfPerSol: number | null;
  /** Why the ASDF price can't be used just now. */
  priceRefusal: string | null;
  burnedCredits: number | null;
  needCredits: number;
  tokensPerCredit: number | null;
  freeRank: number;
  bps: number;
}

const FREE_REASON: Record<string, (freeRank: number) => string> = {
  holder: (n) => `top ${n} holder`,
  admin: () => "admin",
  grant: () => "Pro Mode grant",
  access: () => "ASDF buy",
};

/** Credits, to two decimals. */
const creditsText = (n: number) => n.toFixed(2);

/**
 * The Sacrifice's line for the confirm step and the cost box, or null while it is off: "Sacrifice:
 * 14.80 credits (0.2% fee, paid in burned ASDF, about 0.002 SOL)", or "Sacrifice: none (top 250
 * holder)". `sizeSol` re-sizes a quote made on another amount (the fee read's 0.1 SOL) to the
 * trade's own; a build's quote is already the trade's.
 */
export function sacrificeLine(v: SacrificeView | null | undefined, sizeSol?: number): string | null {
  if (!v || v.mode === "off") return null;
  const preview = v.mode === "shadow" ? " Not charged yet." : "";
  if (!v.pays) return `Sacrifice: none (${FREE_REASON[v.reason ?? ""]?.(v.freeRank) ?? "free"}).${preview}`;
  if (v.priceRefusal)
    return `Sacrifice: 0.2% in burned credits, but ${v.priceRefusal.charAt(0).toLowerCase()}${v.priceRefusal.slice(1)}`;
  let credits = v.credits;
  let sol = v.lamports !== null ? Number(v.lamports) / 1e9 : null;
  if (sizeSol !== undefined && v.asdfPerSol && v.tokensPerCredit) {
    sol = (sizeSol * v.bps) / 10_000;
    credits = Math.ceil(((sol * v.asdfPerSol) / v.tokensPerCredit) * 100) / 100;
  }
  if (credits === null || sol === null) return null;
  return `Sacrifice: ${creditsText(credits)} credits (0.2% fee, paid in burned ASDF, about ${Number(sol.toPrecision(2))} SOL).${preview}`;
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
  /**
   * The rent of the token accounts a buy opens, refunded when they are closed: the coin's on a first
   * buy, and each new one for a token the route hops through. "0" when the wallet has them all.
   */
  accountRentLamports: string;
  /**
   * The tokens the route hops through between SOL and the coin (mints): a coin quoted in PUMP or
   * USDC is bought with SOL through them in one swap. Absent from older API builds.
   */
  routeVia?: string[];
  /** The coins the reference buy would get, raw units, by the route's quote; null without one. Absent from older API builds. */
  outAmount?: string | null;
  /** The coin's decimals; null when unread. */
  decimals?: number | null;
  /** The Sacrifice's rate while it is on and the wallet pays (20), else 0. */
  platformFeeBps?: number;
  sacrifice?: SacrificeView;
}

/** The expected network fee for a trade on `mint` with these settings, re-read every 20s. */
export function useFeeEstimate(
  mint: string,
  settings: TradeSettings,
  side: "buy" | "sell" = "buy",
): FeeEstimate | null {
  const [fee, setFee] = useState<{
    mint: string;
    side: "buy" | "sell";
    speed: "eco" | "turbo";
    value: FeeEstimate;
  } | null>(null);
  // The side matters for $ASDFASDFA only: buying it pays no Sacrifice, selling it does.
  const speed = settings.speed;
  const params = new URLSearchParams({
    mint,
    speed,
    side,
    ...feeParams(settings),
  }).toString();
  useEffect(() => {
    let live = true;
    const load = () =>
      api<FeeEstimate>(`/pro/trade/fee?${params}`)
        .then((f) => live && setFee({ mint, side, speed, value: f }))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 20_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [params, mint, side, speed]);
  return shownFee(mint, side, speed, fee);
}

/** How long the buy amount must sit still before it is quoted: typing doesn't quote every keystroke. */
const QUOTE_SETTLE_MS = 500;

/**
 * The swap costs of a buy of `refSol` on `mint` (GET /pro/trade/costs), re-read every minute: a
 * Jupiter quote each, so a typed amount is quoted only once it has settled. Null `mint`: none.
 */
export function useSwapCosts(mint: string | null, refSol: number): SwapCostEstimate | null {
  const [costs, setCosts] = useState<{ mint: string; value: SwapCostEstimate } | null>(null);
  const wanted = String(Math.round(refSol * 1e9));
  const [ref, setRef] = useState(wanted);
  useEffect(() => {
    if (wanted === ref) return;
    const t = setTimeout(() => setRef(wanted), QUOTE_SETTLE_MS);
    return () => clearTimeout(t);
  }, [wanted, ref]);
  useEffect(() => {
    // No coin: nothing to quote (the caller isn't showing a buy).
    if (!mint) return;
    let live = true;
    const asked = mint;
    const load = () =>
      api<SwapCostEstimate>(`/pro/trade/costs?${new URLSearchParams({ mint: asked, refLamports: ref })}`)
        .then((c) => live && setCosts({ mint: asked, value: c }))
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
  return shownQuote(mint, costs);
}

/** GET /pro/trade/sale-quote: what a sale of `units` raw coins would get, lamports. */
export interface SaleQuote {
  units: string;
  outLamports: string;
}

/**
 * The route's quote for a sale of `units` raw coins of `mint` into SOL (GET /pro/trade/sale-quote),
 * once the amount has settled, re-read every minute. The last quote is kept while a new amount
 * waits, so the preview can scale it. Null `mint` or `units`: nothing is quoted.
 */
export function useSaleQuote(mint: string | null, units: bigint | null): SaleQuote | null {
  const [quote, setQuote] = useState<{ mint: string; value: SaleQuote } | null>(null);
  const wanted = units !== null && units > 0n ? units.toString() : null;
  const [ref, setRef] = useState(wanted);
  useEffect(() => {
    if (wanted === ref) return;
    const t = setTimeout(() => setRef(wanted), QUOTE_SETTLE_MS);
    return () => clearTimeout(t);
  }, [wanted, ref]);
  useEffect(() => {
    if (!mint || !ref) return;
    let live = true;
    const asked = mint;
    const load = () =>
      api<SaleQuote>(`/pro/trade/sale-quote?${new URLSearchParams({ mint: asked, units: ref })}`)
        .then((q) => live && setQuote({ mint: asked, value: q }))
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
  return shownQuote(mint, quote);
}

/**
 * The SOL a sale of `units` raw coins is expected to get: the route's quote when it was made on
 * this amount; else that quote scaled to it, or (without one) `worthSol`, the coins' share of the
 * position's value at today's price, while the amount waits to be quoted. Null when nothing is known.
 */
export function expectedSol(
  units: bigint | null,
  quote: SaleQuote | null,
  worthSol: number | null,
): { sol: number; quoted: boolean } | null {
  if (units === null || units <= 0n) return null;
  if (quote && BigInt(quote.units) > 0n && /^\d+$/.test(quote.outLamports)) {
    const out = Number(BigInt(quote.outLamports)) / 1e9;
    if (quote.units === units.toString()) return { sol: out, quoted: true };
    return { sol: (Number(units) / Number(BigInt(quote.units))) * out, quoted: false };
  }
  return worthSol !== null && worthSol > 0 ? { sol: worthSol, quoted: false } : null;
}

/**
 * The coins a buy of `lamports` is expected to get, whole coins: the route's quote when it was made
 * on this amount; else the price that quote filled at (or, without one, today's price `priceSol`,
 * SOL per coin) scaled to it, while the amount waits to be quoted. Null when nothing is known.
 */
export function expectedTokens(
  lamports: bigint | null,
  quote: SwapCostEstimate | null,
  priceSol: number | null,
): { tokens: number; quoted: boolean } | null {
  if (lamports === null || lamports <= 0n) return null;
  const sol = Number(lamports) / 1e9;
  if (quote?.outAmount && typeof quote.decimals === "number" && BigInt(quote.outAmount) > 0n) {
    const out = Number(BigInt(quote.outAmount)) / 10 ** quote.decimals;
    if (quote.refLamports === lamports.toString()) return { tokens: out, quoted: true };
    const ref = Number(quote.refLamports) / 1e9;
    if (ref > 0) return { tokens: (sol / ref) * out, quoted: false };
  }
  return priceSol !== null && priceSol > 0 ? { tokens: sol / priceSol, quoted: false } : null;
}

// ---- The wallet's position in a coin ----

/**
 * Fees saved (user ask 2026-10-19) are counted against a 0.95% platform fee on each buy and sale: the
 * highest of the platforms the Portfolio page compares (Axiom's entry tier net of cashback,
 * apps/api/src/tradeFees.ts).
 */
export const FEE_BASELINE_BPS = 95;
export const FEE_BASELINE_TEXT = `vs a ${FEE_BASELINE_BPS / 100}% fee`;

/** What a trade of `sizeSol` saves against the baseline fee, less what we charge on it. */
export function feeSavedSol(sizeSol: number, chargedSol = 0): number {
  return (sizeSol * FEE_BASELINE_BPS) / 10_000 - chargedSol;
}

/** GET /pro/trade/:mint/position. Amounts are decimal strings (u64s never go through a float). */
export interface PositionResponse {
  wallet: string;
  mint: string;
  decimals: number | null;
  balance: string;
  /** The associated account the route debits, raw units. Absent on older API builds (then `balance`). */
  tradable?: string;
  /** Raw units in other token accounts. Absent when there are none or the API is older. */
  elsewhere?: string;
  /** Token-2022 transfer fee, basis points. 0 when the mint has none. */
  transferFeeBps?: number;
  /** Sell all: `tradable` after the transfer fee. Absent on older API builds. */
  sellable?: string;
  supply: string | null;
  solUsd: number | null;
  /** When solUsd was read (ISO): the SOL price is kept through failed reads. Absent from older API builds. */
  solUsdAt?: string | null;
  trades: {
    signature: string;
    t: number;
    side: "buy" | "sell" | "in" | "out";
    lamports: string;
    tokens: string;
    /** Made from our Trade panel: its SOL value and what we charged, lamports. Absent from older API builds. */
    panel?: { lamports: string; platformFeeLamports: string } | null;
  }[];
  historyUnavailable: boolean;
  truncated: boolean;
}

/** How often an open position is read again. The live SOL balance uses this same cadence (walletBalance.ts). */
export const POSITION_POLL_MS = 15_000;

/**
 * The Pro wallet's position in `mint`, polled while `mint` is set (null: not Pro, or no modal). A
 * failed read keeps the last position, with `error` set and `at` saying when it was read.
 */
/**
 * The position to show for `mint`. A read for another coin (the one still in state while the next
 * coin's request is in flight) is not that coin's balance. An error counts only for the mint it
 * was read for, so a failed refresh of this coin still shows its last position.
 */
export function shownPosition(
  mint: string | null,
  data: PositionResponse | null,
  error: Error | null,
  at: number | null,
  errorMint: string | null,
): { data: PositionResponse | null; error: Error | null; at: number | null } {
  const same = mint !== null && data?.mint === mint ? data : null;
  return { data: same, error: mint !== null && errorMint === mint ? error : null, at: same ? at : null };
}

export function usePosition(mint: string | null): {
  data: PositionResponse | null;
  error: Error | null;
  at: number | null;
  reload: () => void;
} {
  const [data, setData] = useState<PositionResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [at, setAt] = useState<number | null>(null);
  /** The mint `error` belongs to. A failed read keeps the last position only for that coin. */
  const [errorMint, setErrorMint] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!mint) return;
    const mine = ++seq.current;
    const asked = mint;
    api<PositionResponse>(`/pro/trade/${encodeURIComponent(mint)}/position`)
      .then((d) => {
        if (mine !== seq.current || d.mint !== asked) return;
        setData(d);
        setAt(Date.now());
        setError(null);
        setErrorMint(asked);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setErrorMint(asked);
      });
  }, [mint]);
  useEffect(() => {
    setData(null);
    setError(null);
    setAt(null);
    setErrorMint(null);
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
  return { ...shownPosition(mint, data, error, at, errorMint), reload: load };
}

/**
 * What the position adds up to, in SOL and the coin's market cap terms. The position is the current
 * trade: from the latest buy into an empty (or dust) holding, so an earlier round trip in the same
 * coin doesn't blur this one's cost or result. Its cost is the average cost of the coins bought,
 * fees and slippage in (the API leaves token-account rent out: it comes back on close).
 */
export interface PositionSummary {
  /** Tokens held, in whole tokens. */
  held: number;
  /** Share of supply held (0..1); null without a supply. */
  share: number | null;
  /** SOL spent on this position's buys and got back from its sales. */
  solIn: number;
  solOut: number;
  /** What went in for the coins traded or still held: the buys, less the cost of coins sent away. */
  investedSol: number;
  /** The position's value now in SOL, from the chart's latest market cap; null when it can't be priced. */
  valueSol: number | null;
  /** Realized plus unrealized, and that as a share of what went in. */
  pnlSol: number | null;
  pnlPct: number | null;
  /** What the sales made over what the coins they sold cost; null when the cost is unknown. */
  realizedSol: number | null;
  /** The coins still held at today's value against what they cost; null when it can't be priced. */
  unrealizedSol: number | null;
  /** The average market cap the position's coins were bought at (USD), by the buys' own prices. */
  entryMcap: number | null;
  /**
   * The market cap (USD) at which the coins still held would bring the position back to even,
   * sales included: 0 when the sales already covered what it cost. Null with nothing held at a cost.
   */
  breakEvenMcap: number | null;
  /** When the position's first and latest trades landed (ms); null without trades. */
  firstAt: number | null;
  lastAt: number | null;
  buys: number;
  sells: number;
  /** What this position's trades from our Trade panel saved against the baseline fee, SOL. */
  feesSavedSol: number;
}

export function summarizePosition(p: PositionResponse, nowMcapUsd: number | null): PositionSummary {
  const dec = p.decimals ?? 6;
  const scale = 10 ** dec;
  const balance = BigInt(p.balance);
  const held = Number(balance) / scale;
  const supply = p.supply ? Number(BigInt(p.supply)) / scale : null;
  const trades = p.trades.map((t) => ({
    t: t.t,
    side: t.side,
    lamports: BigInt(t.lamports),
    tokens: BigInt(t.tokens),
    panel: t.panel ?? null,
  }));

  // Walk back from today's balance to the latest buy made into a holding under 1% of that buy:
  // the current position's start. Without one, the whole history is the position, unless older
  // trades were left out (then its start, and its cost, are unknown).
  let start: number | null = null;
  let carried = 0n;
  let after = balance;
  for (let i = trades.length - 1; i >= 0; i--) {
    const before = after - trades[i]!.tokens;
    if (before < 0n) break;
    if (trades[i]!.side === "buy" && before * 100n <= trades[i]!.tokens) {
      start = i;
      carried = before;
      break;
    }
    after = before;
    if (i === 0 && !p.truncated) {
      start = 0;
      carried = before;
    }
  }
  if (start === null && trades.length === 0 && !p.truncated) start = 0;

  let solIn = 0;
  let solOut = 0;
  let buys = 0;
  let sells = 0;
  // The average-cost book, raw coins: those bought at a known cost, and those with none (dust
  // carried in, coins sent to the wallet).
  let costed = 0;
  let uncosted = Number(carried);
  let cost = 0;
  let realized = 0;
  let sentCost = 0;
  let costedBought = 0;
  const take = (raw: number) => {
    const total = costed + uncosted;
    const n = Math.min(raw, total);
    if (n <= 0) return { share: 0, cost: 0 };
    const fromCosted = (n * costed) / total;
    const out = costed > 0 ? (cost * fromCosted) / costed : 0;
    costed -= fromCosted;
    uncosted -= n - fromCosted;
    cost -= out;
    return { share: fromCosted / raw, cost: out };
  };
  for (const t of start === null ? [] : trades.slice(start)) {
    const sol = Number(t.lamports) / 1e9;
    const raw = Number(t.tokens);
    if (t.side === "buy") {
      buys++;
      solIn += -sol;
      cost += -sol;
      costed += raw;
      costedBought += raw;
    } else if (t.side === "sell") {
      sells++;
      solOut += sol;
      const out = take(-raw);
      realized += sol * out.share - out.cost;
    } else if (t.side === "in") {
      uncosted += raw;
    } else {
      sentCost += take(-raw).cost;
    }
  }
  const investedSol = Math.max(0, solIn - sentCost);
  const share = supply && supply > 0 ? held / supply : null;
  const valueSol =
    share !== null && nowMcapUsd !== null && p.solUsd
      ? (share * nowMcapUsd) / p.solUsd
      : held === 0
        ? 0
        : null;
  const known = start !== null && investedSol > 0;
  // Only the coins with a cost count toward the result: coins sent to the wallet cost it nothing.
  const costedValue =
    valueSol === null ? null : balance > 0n ? valueSol * Math.min(1, costed / Number(balance)) : 0;
  const unrealizedSol = known && costedValue !== null ? costedValue - Math.max(0, cost) : null;
  const pnlSol = unrealizedSol !== null ? realized + unrealizedSol : null;
  const pnlPct = pnlSol !== null ? pnlSol / investedSol : null;
  // SOL per token paid across the buys, as a market cap: the line the chart draws as "Entry".
  const entryMcap =
    costedBought > 0 && supply && p.solUsd ? (solIn / (costedBought / scale)) * supply * p.solUsd : null;
  const mine = start === null ? [] : trades.slice(start);
  const feesSavedSol = mine.reduce(
    (sum, t) =>
      t.panel
        ? sum + feeSavedSol(Number(t.panel.lamports) / 1e9, Number(t.panel.platformFeeLamports) / 1e9)
        : sum,
    0,
  );
  // The held coins' price that makes realized + their value - their cost = 0.
  const costedCoins = costed / scale;
  const evenSol =
    known && costedCoins > 0 && balance > 0n ? (Math.max(0, cost) - realized) / costedCoins : null;
  const breakEvenMcap =
    evenSol !== null && supply && p.solUsd ? Math.max(0, evenSol) * supply * p.solUsd : null;
  return {
    held,
    share,
    solIn,
    solOut,
    investedSol,
    valueSol,
    pnlSol,
    pnlPct,
    realizedSol: known ? realized : null,
    unrealizedSol,
    entryMcap,
    breakEvenMcap,
    firstAt: mine[0]?.t ?? null,
    lastAt: mine[mine.length - 1]?.t ?? null,
    buys,
    sells,
    feesSavedSol,
  };
}

// ---- Trading ----

export interface BuiltTrade {
  transaction: string;
  lastValidBlockHeight: number;
  route: "jupiter" | "pump" | "pumpswap";
  /**
   * A curve quoted in another coin: that coin's mint. The build swaps SOL to it with Jupiter and
   * buys on the curve with it, or sells on the curve and swaps what that paid back to SOL.
   */
  via?: string;
  quotedOut: string;
  minOut: string;
  tipLamports: string;
  priorityFeeLamports: string;
  /**
   * The coin is one the wallet holds, that passed the safety screen, or that a model called: a
   * Privy wallet may sign it without Privy's confirm window (user rule 2026-10-18).
   */
  quietSign?: boolean;
  /** The Sacrifice this trade takes (or would, in shadow mode): the send takes exactly this. */
  sacrifice?: SacrificeView;
  /** The build, signed by the API: sent back with the signed trade, so any API instance takes it. */
  buildToken?: string;
  /** When the blockhash was fetched (ms), on the API's clock. Absent on older API builds. */
  blockhashAt?: number;
  /** The blockhash's age as the answer left the API. Absent on older API builds. */
  blockhashAgeMs?: number;
  /** The mint's decimals. Null when unknown; absent on older API builds. */
  decimals?: number | null;
  /** Rent this build opens, lamports. The sign line uses this, not an earlier preview. */
  accountRentLamports?: string;
  /** Raw units of this coin that sit outside the account the route debits. */
  elsewhere?: string;
  /**
   * A sell preset: the raw units the build sold, and the balance it read them from. The page checks
   * the units are that percent of that balance before it asks the wallet to sign.
   */
  inputAmount?: string;
  inputBalance?: string;
}

export type TradeStage = "building" | "signing" | "sending" | "confirming";

export class TradeError extends Error {
  constructor(
    message: string,
    /** Set once the trade went out: it may still land, so check before trading again. */
    readonly signature?: string,
    /**
     * The chain has settled it (confirmed is a return, not an error; failed or expired). A give-up
     * or a lost send is not settled: the in-flight lock stays.
     */
    readonly settled = false,
  ) {
    super(message);
  }
}

/** The trade's blockhash ran out before it landed: nothing changed, and it can go again at Turbo. */
export class TradeExpiredError extends TradeError {
  constructor(message: string, signature?: string) {
    super(message, signature, true);
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
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
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
 * V1's arguments end in in_amount (u64), quoted_out (u64), slippage_bps (u16), platform_fee_bps (u8).
 * V2's (Jupiter's on-chain IDL) start at `args`, after the discriminator and a shared route's id:
 * in_amount (u64), quoted_out (u64), slippage_bps (u16), platform_fee_bps (u16),
 * positive_slippage_bps (u16), then the route plan.
 */
const JUPITER_ROUTES = new Map<string, { source: number; dest: number; ledger: boolean; args?: number }>([
  ["229,23,203,151,122,227,173,42", { source: 2, dest: 3, ledger: false }], // route: user_source/destination_token_account
  ["193,32,155,51,65,214,156,129", { source: 3, dest: 6, ledger: false }], // shared_accounts_route: source/destination_token_account
  // The same swapping what a token ledger measured, for a curve sale's quote coin: no in_amount,
  // their arguments end in quoted_out, slippage_bps, platform_fee_bps.
  ["150,86,71,116,167,93,14,104", { source: 2, dest: 3, ledger: true }], // route_with_token_ledger
  ["230,121,143,80,119,159,106,170", { source: 3, dest: 6, ledger: true }], // shared_accounts_route_with_token_ledger
  ["187,100,250,204,49,196,175,20", { source: 1, dest: 2, ledger: false, args: 8 }], // route_v2: user_source/destination_token_account
  ["209,152,83,147,124,254,216,233", { source: 2, dest: 5, ledger: false, args: 9 }], // shared_accounts_route_v2: source/destination_token_account
]);
/** Jupiter's set_token_ledger: [token_ledger, token_account]. */
const JUPITER_SET_LEDGER = "228,85,185,112,78,79,77,2";
/** Pump.fun v3: buy_exact_quote_in_v3 (sol in, min tokens) and sell_v3 (tokens, min sol). */
const PUMP_BUY = "225,247,80,30,213,179,132,136";
const PUMP_SELL = "28,146,222,119,38,196,105,213";
const PUMP_SWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
/**
 * PumpSwap v2, a graduated coin's pool: buy_exact_quote_in_v2 (sol in, min tokens) and sell_v2
 * (tokens, min sol). Accounts: user 2nd, the user's coin account 6th, its wrapped SOL 7th.
 */
const PUMP_SWAP_BUY = "194,171,28,70,104,77,91,47";
const PUMP_SWAP_SELL = "93,246,130,60,231,233,64,178";

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
  /**
   * A curve quoted in another coin (BuiltTrade.via): the wallet's accounts for that coin. The
   * build is then two swaps, Jupiter's and the curve's, through those accounts.
   */
  ownViaAccounts?: string[];
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
 * output landing in the wallet's own account, its input taken from the wallet's own account for
 * that side (wrapped SOL for a buy, the coin for a sale), and no more SOL wrapped than a buy spends. What a
 * route's quote should be the browser can't know: the API's guard and simulation check that.
 * Returns why it isn't fine, or null. (The wallet's own preview still shows what it does.)
 *
 * Through a curve's quote coin (`ownViaAccounts`), it is two swaps in order. A buy: Jupiter swaps
 * the SOL asked into the wallet's quote-coin account, then the curve spends no more of it than
 * that swap's on-chain minimum, so the quote coin the wallet already held is never spent. A sale:
 * a token ledger on the quote-coin account, the curve sells the coin asked into it, then Jupiter
 * swaps only what the ledger measured to the wallet's wrapped SOL.
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
    const via = trade.ownViaAccounts;
    // Where each step of a two-swap build sits, and what the curve may spend of Jupiter's output.
    let jupiterAt = -1;
    let pumpAt = -1;
    let ledgerAt = -1;
    let jupiterFloor = -1n;
    let curveSpend = 0n;
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
        if (discriminator === JUPITER_SET_LEDGER) {
          if (!via || trade.side !== "sell" || ledgerAt >= 0 || !via.includes(acct(1)))
            return "it has a Jupiter step this trade doesn't need";
          ledgerAt = i;
          continue;
        }
        const at = JUPITER_ROUTES.get(discriminator);
        // Where its in_amount, slippage and fee sit: V2's fixed arguments come before the route plan.
        const v2 = at?.args;
        if (at === undefined || d.length < (v2 === undefined ? 8 + 19 : v2 + 22 + 4))
          return "it has a Jupiter step this trade doesn't need";
        swaps++;
        // V1's in_amount, quoted_out, slippage and fee sit at the end; V2's from `args`.
        const inAt = v2 ?? d.length - 19;
        const quotedAt = v2 === undefined ? d.length - 11 : v2 + 8;
        const fee = v2 === undefined ? d[d.length - 1] : view.getUint16(v2 + 18, true);
        if (fee !== 0) return "Jupiter would take a platform fee";
        if (v2 !== undefined && view.getUint16(v2 + 20, true) !== 0)
          return "Jupiter would take a share of a better price";
        const slippage = view.getUint16(v2 === undefined ? d.length - 3 : v2 + 16, true);
        if (slippage > trade.slippageBps) return "it allows more slippage than you set";
        if (via) {
          // Buy: the SOL asked into the quote coin. Sale: what the curve paid, back to SOL.
          if (at.ledger !== (trade.side === "sell")) return "it has a Jupiter step this trade doesn't need";
          if (jupiterAt >= 0) return "it isn't exactly one swap on each side";
          jupiterAt = i;
          const [from, to] = trade.side === "buy" ? [trade.ownWrappedSol, via] : [via, trade.ownWrappedSol];
          if (!from.includes(acct(at.source)))
            return "it would spend from an account other than the one this trade uses";
          if (!to.includes(acct(at.dest))) return "what it buys wouldn't land in your wallet";
          if (trade.side === "buy") {
            const inAmount = u64At(inAt);
            if (inAmount !== trade.amount) return "its amount isn't the one you asked for";
            jupiterFloor = (u64At(quotedAt) * BigInt(10_000 - slippage)) / 10_000n;
          }
          continue;
        }
        if (at.ledger) return "it has a Jupiter step this trade doesn't need";
        const inAmount = u64At(inAt);
        if (trade.all ? inAmount <= 0n : inAmount !== trade.amount)
          return "its amount isn't the one you asked for";
        const dest = acct(at.dest);
        if (!(trade.side === "buy" ? trade.ownCoinAccounts : trade.ownWrappedSol).includes(dest))
          return "what it buys wouldn't land in your wallet";
        // What it spends must come from the account the trade names: a buy's wrapped SOL, a sale's
        // coin. Without this, a "buy 0.1 SOL" could spend 100,000,000 raw units of any other token
        // the wallet holds (its USDC, say), since only the amount was compared.
        const source = acct(at.source);
        if (!(trade.side === "buy" ? trade.ownWrappedSol : trade.ownCoinAccounts).includes(source))
          return "it would spend from an account other than the one this trade uses";
        continue;
      }
      if (program === PUMP) {
        const side = discriminator === PUMP_BUY ? "buy" : discriminator === PUMP_SELL ? "sell" : null;
        if (!side || d.length < 24) return "it has a Pump.fun step this trade doesn't need";
        swaps++;
        if (side !== trade.side) return "it's a different trade from the one you asked for";
        if (via) {
          if (pumpAt >= 0) return "it isn't exactly one swap on each side";
          pumpAt = i;
          // v3's user accounts: the coin's (10th) and the quote coin's (11th), both the wallet's own.
          if (!trade.ownCoinAccounts.includes(acct(9)) || !via.includes(acct(10)))
            return "what it buys wouldn't land in your wallet";
          if (u64At(16) <= 0n) return "it has no minimum, so any price would do";
          if (side === "buy") {
            curveSpend = u64At(8);
            if (curveSpend <= 0n) return "its amount isn't the one you asked for";
          } else if (trade.all ? u64At(8) <= 0n : u64At(8) !== trade.amount)
            return "its amount isn't the one you asked for";
          continue;
        }
        const amount = u64At(8);
        if (trade.all && side === "sell" ? amount <= 0n : amount !== trade.amount)
          return "its amount isn't the one you asked for";
        if (u64At(16) <= 0n) return "it has no minimum, so any price would do";
        continue;
      }
      if (program === PUMP_SWAP) {
        const side =
          discriminator === PUMP_SWAP_BUY ? "buy" : discriminator === PUMP_SWAP_SELL ? "sell" : null;
        if (!side || d.length < 24) return "it has a PumpSwap step this trade doesn't need";
        swaps++;
        if (via) return "it isn't exactly one swap on each side";
        if (side !== trade.side) return "it's a different trade from the one you asked for";
        // The pool trades for the wallet itself, from and into its own accounts only.
        if (acct(1) !== owner) return "it trades for a wallet that isn't yours";
        if (!trade.ownCoinAccounts.includes(acct(5)) || !trade.ownWrappedSol.includes(acct(6)))
          return "what it buys wouldn't land in your wallet";
        const amount = u64At(8);
        if (trade.all && side === "sell" ? amount <= 0n : amount !== trade.amount)
          return "its amount isn't the one you asked for";
        if (u64At(16) <= 0n) return "it has no minimum, so any price would do";
        continue;
      }
    }
    if (via) {
      if (swaps !== 2 || jupiterAt < 0 || pumpAt < 0) return "it isn't exactly one swap on each side";
      if (trade.side === "buy") {
        if (jupiterAt > pumpAt) return "its swaps are out of order";
        // Never more than Jupiter's swap is sure to deliver: the quote coin already held stays.
        if (curveSpend > jupiterFloor) return "it would spend quote coin you already held";
      } else if (!(ledgerAt >= 0 && ledgerAt < pumpAt && pumpAt < jupiterAt))
        return "its swaps are out of order";
    } else if (swaps !== 1) return "it isn't exactly one swap";
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

/** `pct` percent of a raw balance; all of it at 100. The API's sellShare counts the same way. */
export function shareOf(raw: bigint, pct: number): bigint {
  if (pct >= 100) return raw;
  return (raw * BigInt(Math.round(pct * 100))) / 10_000n;
}

/**
 * A quote kept in a hook, shown only for the coin it was read for. A read for the previous coin
 * must not price this one while the next request is in flight.
 */
export function shownQuote<T>(mint: string | null, quote: { mint: string; value: T } | null): T | null {
  return mint !== null && quote?.mint === mint ? quote.value : null;
}

/** A fee read, shown only for the coin, side and speed it was made for. */
export function shownFee(
  mint: string,
  side: "buy" | "sell",
  speed: "eco" | "turbo",
  quote: { mint: string; side: "buy" | "sell"; speed: "eco" | "turbo"; value: FeeEstimate } | null,
): FeeEstimate | null {
  return quote && quote.mint === mint && quote.side === side && quote.speed === speed ? quote.value : null;
}

/**
 * Whether `message` is a swap outside the slippage it was built with. The same codes the API
 * matches (proTrade.ts slippageMiss): Jupiter 6001 / 0x1771, Pump.fun 6002 and 6003, PumpSwap 6042.
 */
export function slippageMiss(message: string): boolean {
  if (
    /SlippageToleranceExceeded|TooMuchSolRequired|TooLittleSolReceived|ExceededSlippage|under the quoted minimum/i.test(
      message,
    )
  )
    return true;
  if (/0x1771|0x1772|0x1773|0x179a/i.test(message)) return true;
  return /(?:^|[^0-9])(6001|6002|6003|6042)(?:[^0-9]|$)/.test(message);
}

/** The signed trade landed and reverted: the price moved past the slippage set when it was sent. */
export const SLIPPAGE_LANDED =
  "The price moved past your slippage. Nothing was bought or sold. Try again, or raise the slippage.";

/** The price moved before the trade was sent. */
export const SLIPPAGE_UNSENT =
  "The price moved past your slippage. Nothing was sent. Try again, or raise the slippage.";

/** What the panel says when the chain reports the signature failed. Not a fill, and not a timeout. */
export function landedFailureMessage(error?: string, reason?: string, side: "buy" | "sell" = "buy"): string {
  if (reason === "slippage" || (error ? slippageMiss(error) : false)) return SLIPPAGE_LANDED;
  if (error && /InsufficientFundsForRent|rent-exempt/i.test(error))
    return "Not enough SOL left to keep your wallet rent-exempt after this trade. Nothing was bought or sold.";
  if (
    error &&
    side === "sell" &&
    /InsufficientFunds|"Custom":1\b|\b0x1\b/i.test(error) &&
    !slippageMiss(error)
  )
    return "You hold fewer tokens than that sale. Nothing was bought or sold.";
  if (error && /Nothing was bought or sold\.$/.test(error)) return error;
  // A raw program error is not shown as JSON. A timeout keeps its own sentence.
  if (error && /[{}]/.test(error))
    return "The trade landed and the program rejected it. Nothing was bought or sold.";
  return `The trade failed on chain${error ? ` (${error})` : ""}. Nothing was bought or sold.`;
}

/** What a transfer fee leaves the pool from `raw`. Sell all stops here. */
export function sellableAfterTransferFee(raw: bigint, transferFeeBps: number): bigint {
  if (!Number.isInteger(transferFeeBps) || transferFeeBps <= 0) return raw;
  if (transferFeeBps >= 10_000) return 0n;
  const fee = (raw * BigInt(transferFeeBps) + 9_999n) / 10_000n;
  return raw > fee ? raw - fee : 0n;
}

/**
 * Where a sale is sized from: the associated account the route debits, not the sum of every
 * token account. Sell all is that account after the transfer fee.
 */
export function sellSizing(
  position: {
    balance: string;
    tradable?: string;
    elsewhere?: string;
    transferFeeBps?: number;
    sellable?: string;
  } | null,
): { ata: bigint; elsewhere: bigint; sellable: bigint; feeBps: number } {
  const total = position && /^\d+$/.test(position.balance) ? BigInt(position.balance) : 0n;
  const ata =
    position?.tradable !== undefined && /^\d+$/.test(position.tradable) ? BigInt(position.tradable) : total;
  const elsewhere =
    position?.elsewhere !== undefined && /^\d+$/.test(position.elsewhere) ? BigInt(position.elsewhere) : 0n;
  const feeBps =
    typeof position?.transferFeeBps === "number" && position.transferFeeBps > 0 ? position.transferFeeBps : 0;
  const sellable =
    position?.sellable !== undefined && /^\d+$/.test(position.sellable)
      ? BigInt(position.sellable)
      : sellableAfterTransferFee(ata, feeBps);
  return { ata, elsewhere, sellable, feeBps };
}

/** A failed refresh must not sell the whole balance it last showed. */
export const STALE_TOTAL_SALE =
  "Couldn't refresh your position, so this sale of the whole balance wasn't sent.";

/** Pro turned off mid-session: App refreshes /auth/me and hides trading. */
const sessionRefreshers = new Set<() => void>();
export function onTradingSessionRefresh(cb: () => void): () => void {
  sessionRefreshers.add(cb);
  return () => sessionRefreshers.delete(cb);
}
export function tradingUnavailable(): void {
  for (const cb of sessionRefreshers) cb();
}

export const TRADING_OFF = "Trading isn't available for this wallet right now. Nothing was sent.";
export const STATUS_MAYBE =
  "Trading is off for this wallet now. This trade may still have landed. Check it before trading again.";

/** The API's one trade per second per wallet (sales of 100% exempt), checked here first. */
export const TRADE_COOLDOWN_MS = 1_000;

/** "every second", or "every N seconds" when the API's window is something else. */
export function tradePacePhrase(ms = TRADE_COOLDOWN_MS): string {
  return ms === 1_000 ? "every second" : `every ${ms / 1_000} seconds`;
}
/**
 * When each wallet last sent a trade from this page: the Trade panels, quick buy and the access
 * buy alike, so a quick buy straight after a panel trade says "wait" instead of a round trip.
 */
const lastSentAt = new Map<string, number>();

/** Milliseconds until `owner` may trade again here; 0 when it may now. */
export function tradeCooldownLeft(owner: string, now = Date.now()): number {
  return Math.max(0, (lastSentAt.get(owner) ?? -Infinity) + TRADE_COOLDOWN_MS - now);
}

/**
 * One trade at a time per wallet, for the life of the page. Preparing covers build and sign, so
 * two panels can't both open the wallet. Live is a signature that has been sent: closing the
 * token window, or giving up after 90s, does not drop it. It drops when the chain settles it
 * (confirmed, failed, expired) or the blockhash's life has passed.
 */
type WalletSlot =
  | { kind: "preparing"; mint: string; id: number; prevPace: number | undefined; paced: boolean }
  | { kind: "live"; mint: string; id: number; signature: string; liveAt: number };

const walletSlots = new Map<string, WalletSlot>();
let walletSlotId = 0;

export function walletTradeBlock(owner: string): string | null {
  const slot = walletSlots.get(owner);
  if (!slot) return null;
  if (slot.kind === "preparing")
    return "This wallet is already signing a trade. Wait for that one to finish.";
  return "A trade from this wallet is still in flight. Wait for it to land before trading again.";
}

function claimWallet(owner: string, mint: string, pace: boolean): number {
  const blocked = walletTradeBlock(owner);
  if (blocked) throw new TradeError(blocked);
  const prevPace = lastSentAt.get(owner);
  // The pace starts when the click is accepted, so a second panel can't both build before the
  // send returns. A closing sale stays exempt from the one-second pace and still takes the lock.
  if (pace) {
    const left = tradeCooldownLeft(owner);
    if (left > 0)
      throw new TradeError(`One trade ${tradePacePhrase()}: try again in ${Math.ceil(left / 1_000)}s.`);
    lastSentAt.set(owner, Date.now());
  }
  const id = ++walletSlotId;
  walletSlots.set(owner, { kind: "preparing", mint, id, prevPace, paced: pace });
  return id;
}

function releaseUnsent(owner: string, id: number): void {
  const slot = walletSlots.get(owner);
  if (!slot || slot.kind !== "preparing" || slot.id !== id) return;
  walletSlots.delete(owner);
  if (!slot.paced) return;
  if (slot.prevPace === undefined) lastSentAt.delete(owner);
  else lastSentAt.set(owner, slot.prevPace);
}

/**
 * The lock's window starts on this browser's clock when the signature goes out. The build's
 * blockhashAt is the API's clock: against Date.now() here, a browser running fast would skip the
 * wait and drop the lock at once, and a slow one would hold it too long. The blockhash was fetched
 * before the send, so counting from the send only ever waits a little longer than its life.
 */
function markLive(owner: string, id: number, signature: string): void {
  const slot = walletSlots.get(owner);
  if (!slot || slot.id !== id) return;
  walletSlots.set(owner, { kind: "live", mint: slot.mint, id, signature, liveAt: Date.now() });
}

function clearSlot(owner: string, id: number): void {
  const slot = walletSlots.get(owner);
  if (slot && slot.id === id) walletSlots.delete(owner);
}

/** Keeps polling after the panel gives up, and drops the lock once the chain settles the signature. */
function watchLive(owner: string, id: number, signature: string): void {
  if (typeof window === "undefined") return;
  const live = walletSlots.get(owner);
  if (!live || live.kind !== "live" || live.id !== id) return;
  void (async () => {
    const until = live.liveAt + 90_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, STATUS_POLL_MS));
      const slot = walletSlots.get(owner);
      if (!slot || slot.kind !== "live" || slot.id !== id) return;
      try {
        const s = await api<{ state: string }>(`/pro/trade/status/${encodeURIComponent(signature)}`, {
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        });
        if (s.state === "confirmed" || s.state === "failed" || s.state === "expired") {
          clearSlot(owner, id);
          return;
        }
      } catch {
        // A 404 (trading turned off) still leaves the signature locked until the blockhash is done.
      }
    }
    const slot = walletSlots.get(owner);
    if (slot?.kind === "live" && slot.id === id) walletSlots.delete(owner);
  })();
}

export function resetTradeSessionForTests(): void {
  lastSentAt.clear();
  walletSlots.clear();
}

const STATUS_POLL_MS = 1_200;
const CONFIRM_GIVE_UP_MS = 90_000;
/**
 * The longest the panel waits on a build (the API retries a busy chain or Jupiter itself) and on
 * one status poll. A send that takes longer than SEND_WAIT_MS is watched by its signature instead
 * of spinning: the request may have gone out, so the wait is not reported as a slippage miss.
 */
export const BUILD_TIMEOUT_MS = 45_000;
export const STATUS_TIMEOUT_MS = 8_000;
/** How long /send may sit unanswered before the signature we already know is polled. */
export const SEND_WAIT_MS = 20_000;
/**
 * After an unanswered send, how long to watch a signature that has not been seen at all. Once it
 * is seen, the full confirm window applies: it may still land, and a retry would be a second trade.
 */
const UNCLEAR_SEND_POLL_MS = 20_000;
/**
 * A blockhash lives about 60-80 seconds from the build: a signature that took longer than this is
 * built and signed afresh rather than sent to expire.
 */
export const SIGN_FRESH_MS = 40_000;

/** The browser gave up waiting on the API (AbortSignal.timeout). */
function timedOut(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

/**
 * POST /pro/trade/build, with two-factor when the API asks for it, and never longer than
 * BUILD_TIMEOUT_MS a request: a build that hangs (an API restart) says so instead of spinning.
 */
async function buildTrade(input: {
  mint: string;
  side: "buy" | "sell";
  amount: bigint;
  all?: boolean;
  /** A sell preset's percent. The API reads the balance and sells this share of it. */
  percent?: number;
  settings: TradeSettings;
  sacrificeNote?: string | null;
}): Promise<BuiltTrade> {
  const body = JSON.stringify({
    mint: input.mint,
    side: input.side,
    amount: input.amount.toString(),
    slippageBps: Math.round(input.settings.slippagePct * 100),
    speed: input.settings.speed,
    ...feeParams(input.settings),
    ...(input.all ? { all: true } : {}),
    ...(input.percent !== undefined ? { percent: input.percent } : {}),
  });
  try {
    // Two-factor, when the user chose it for this side (or this size): the API asks, we prompt.
    return await withTwoFactor(
      (headers) =>
        api<BuiltTrade>("/pro/trade/build", {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(BUILD_TIMEOUT_MS),
        }),
      input.sacrificeNote ?? undefined,
    );
  } catch (e) {
    if (timedOut(e))
      throw new TradeError("The server took too long to build the trade. Nothing was sent; try again.");
    throw e;
  }
}

/**
 * Whether a Privy signing failure is Privy being unreachable (offline, down, timing out) rather
 * than a refusal or a cancel: those get their own message, this one says it's Privy's side.
 */
export function privyUnreachable(e: unknown): boolean {
  for (let cause = e, depth = 0; cause && depth < 4; depth++) {
    if (cause instanceof TypeError && /fetch|network|load failed/i.test(cause.message)) return true;
    const { message, code, status } = cause as { message?: unknown; code?: unknown; status?: unknown };
    if (typeof status === "number" && status >= 500) return true;
    const text = `${typeof code === "string" ? code : ""} ${typeof message === "string" ? message : ""}`;
    if (
      /network|failed to fetch|load failed|fetch failed|unreachable|timed? ?out|service unavailable|bad gateway|ECONN|offline|\b50[234]\b/i.test(
        text,
      )
    )
      return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * One trade, start to finish: build (the API checks it by simulation), sign in the wallet, send
 * through Sender, then wait for it to land. Resolves with the signature once confirmed.
 */
/** /send, given up after SEND_WAIT_MS. A timeout throws; the signature may still have gone out. */
async function postSend(body: unknown): Promise<{ signature: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      post<{ signature: string }>("/pro/trade/send", body),
      new Promise<{ signature: string }>((_, reject) => {
        timer = setTimeout(
          () => reject(new DOMException("The operation timed out.", "TimeoutError")),
          SEND_WAIT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Poll /status until the signature confirms, fails, expires, or the wait runs out. A failure is
 * never a fill. Slippage is its own sentence; a timeout stays "still waiting" or "lost touch".
 */
async function confirmTrade(
  signature: string,
  uncertain: boolean,
  side: "buy" | "sell",
  giveUpMs = CONFIRM_GIVE_UP_MS,
): Promise<string> {
  const started = Date.now();
  let seen = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, STATUS_POLL_MS));
    // A poll that hangs (an API restart) is given up on and asked again, so the give-up below
    // still comes on time. A 404 is not "unknown": trading may have been turned off after the send.
    let s: { state: string; error?: string; reason?: string };
    try {
      s = await api<{ state: string; error?: string; reason?: string }>(
        `/pro/trade/status/${encodeURIComponent(signature)}`,
        { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) },
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw e;
      s = { state: "unknown" };
    }
    if (s.state === "confirmed") return signature;
    // Processed has landed and not failed. It is not a success to close on, and not a failure.
    if (s.state === "processed" || s.state === "pending") seen = true;
    if (s.state === "failed")
      throw new TradeError(landedFailureMessage(s.error, s.reason, side), signature, true);
    if (s.state === "expired")
      throw new TradeExpiredError(
        "The trade didn't land in time and has expired. Nothing changed.",
        signature,
      );
    // Unseen after an unanswered send: stop soon, and say it may have landed. Once the chain has
    // seen it, wait the full window so a retry isn't a second trade of one that's still in flight.
    const limit = !uncertain || seen ? giveUpMs : UNCLEAR_SEND_POLL_MS;
    if (Date.now() - started > limit)
      throw new TradeError(
        uncertain && !seen
          ? "Lost touch with the server while sending. It may still land: check your wallet before trading again."
          : "Still waiting on the chain. Check your wallet before trading again.",
        signature,
      );
  }
}

/**
 * When the build's blockhash was fetched, on this browser's clock: the build answer's arrival less
 * the age the API reports. blockhashAt is the API's own clock, and against Date.now() here a
 * browser clock off by more than SIGN_FRESH_MS would call every blockhash late (or none). An older
 * API without the age counts from the arrival, which misses only the build's own few seconds.
 */
export function blockhashFetchedAt(built: { blockhashAgeMs?: number }, arrivedAt: number): number {
  const age = built.blockhashAgeMs;
  return typeof age === "number" && Number.isFinite(age) && age > 0 ? arrivedAt - age : arrivedAt;
}

function blockhashLate(fetchedAt: number, now = Date.now()): boolean {
  return now - fetchedAt > SIGN_FRESH_MS;
}

function windowClosed(): TradeError {
  return new TradeError("This window closed before the trade was signed. Nothing was sent.");
}

export async function runTrade(
  input: {
    owner: string;
    mint: string;
    side: "buy" | "sell";
    amount: bigint;
    /** A sale of the whole balance, as the chain has it when the trade is built. */
    all?: boolean;
    /** A sell preset's percent of the balance the API reads at build time. */
    percent?: number;
    settings: TradeSettings;
    /** The trade's Sacrifice line, for the two-factor prompt (sacrificeLine). */
    sacrificeNote?: string | null;
    /** Set when the token window or quick-trade dialog closes. Checked before the wallet opens. */
    signal?: AbortSignal;
  },
  onStage: (stage: TradeStage, built?: BuiltTrade) => void | Promise<void>,
): Promise<string> {
  // One signature at a time for this wallet, taken before any await so two panels can't both sign.
  // A closing sale is in that lock and exempt from the one-second pace, as the API is.
  const closing = input.all === true || (input.percent ?? 0) >= 100;
  const slot = claimWallet(input.owner, input.mint, !closing);
  let sentOut = false;
  try {
    // Slippage, speed and MEV as they were when Buy or Sell was pressed. A rebuild after a slow
    // signature uses these, not a setting changed while the wallet was open, and the send uses the
    // same speed the build tipped for.
    const settings: TradeSettings = { ...input.settings };
    const asked = { ...input, settings };
    if (input.signal?.aborted) throw windowClosed();
    // The wallet first: if it isn't here there's no point building anything.
    const { account, sign, name } = await accountFor(asked.owner);
    const { ownTokenAccounts, ownWrappedSolAccounts } = await import("./solanaPda");
    // Built and signed again, once, when the blockhash is already late or the wallet took so long
    // that it is nearly spent: sent, it would only expire. The slippage is not widened.
    let built!: BuiltTrade;
    let fetchedAt = 0;
    let signedBytes: Uint8Array | undefined;
    for (let attempt = 0; ; attempt++) {
      if (input.signal?.aborted) throw windowClosed();
      onStage("building");
      try {
        built = await buildTrade(asked);
        fetchedAt = blockhashFetchedAt(built, Date.now());
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          tradingUnavailable();
          throw new TradeError(TRADING_OFF);
        }
        throw e;
      }
      let amount = asked.amount;
      let all = asked.all;
      if (
        asked.percent !== undefined &&
        built.inputAmount &&
        built.inputBalance &&
        /^\d+$/.test(built.inputAmount) &&
        /^\d+$/.test(built.inputBalance)
      ) {
        const balance = BigInt(built.inputBalance);
        const sold = BigInt(built.inputAmount);
        if (shareOf(balance, asked.percent) !== sold)
          throw new TradeError(
            "The trade built for you looks wrong (its amount isn't the percent you asked for), so it wasn't signed.",
          );
        amount = sold;
        all = asked.percent >= 100;
      }
      const unsigned = fromBase64(built.transaction);
      const problem = tradeProblem(unsigned, asked.owner, {
        side: asked.side,
        amount,
        all,
        slippageBps: Math.round(settings.slippagePct * 100),
        ownWrappedSol: ownWrappedSolAccounts(asked.owner),
        ownCoinAccounts: ownTokenAccounts(asked.owner, asked.mint),
        ...(built.via ? { ownViaAccounts: ownTokenAccounts(asked.owner, built.via) } : {}),
      });
      if (problem)
        throw new TradeError(`The trade built for you looks wrong (${problem}), so it wasn't signed.`);
      // A buy is not signed until the mint's decimals are known: the quote on screen has to be
      // the one in the transaction. An omitted field (an older build) still signs.
      if (asked.side === "buy" && built.decimals === null)
        throw new TradeError(
          "This coin's decimals aren't known yet, so nothing was signed. Try again once the mint is known.",
        );
      if (blockhashLate(fetchedAt)) {
        if (attempt > 0)
          throw new TradeError(
            "The quote's blockhash expired before it could be signed. Nothing was sent; try again.",
          );
        continue;
      }
      if (input.signal?.aborted) throw windowClosed();
      // The quote has to be on screen before the wallet opens.
      await Promise.resolve(onStage("signing", built));
      if (input.signal?.aborted) throw windowClosed();
      // Privy's confirm window shows for every trade but one the API marked quiet, and only after
      // the check above passed: a coin the wallet holds, that passed the safety screen, or a model called.
      const quiet = built.quietSign === true && name === PRIVY_WALLET_NAME;
      const signingStarted = Date.now();
      try {
        signedBytes = quiet
          ? await withTimeout(
              privyControls().then((privy) => privy.signQuietly(input.owner, unsigned)),
              "sign",
            )
          : (
              await withTimeout(
                sign.signTransaction({ account, transaction: unsigned, chain: "solana:mainnet" }),
                "sign",
              )
            )[0]?.signedTransaction;
      } catch (e) {
        if (name === PRIVY_WALLET_NAME && privyUnreachable(e))
          throw new TradeError(
            "Privy is unreachable right now, so the trade couldn't be signed. Nothing was sent.",
          );
        throw e;
      }
      if (input.signal?.aborted) throw windowClosed();
      if (!signedBytes) throw new TradeError(`${name} returned no signed transaction`);
      if (!blockhashLate(fetchedAt) && Date.now() - signingStarted <= SIGN_FRESH_MS) break;
      if (attempt > 0)
        throw new TradeError(
          "That took too long to sign, so it would have expired. Nothing was sent; try again.",
        );
    }
    const bytes = Uint8Array.from(signedBytes);
    // Its signature, known from here on (one signer: the 64 bytes after the count), so anything
    // that goes wrong past this point can say which transaction to check before trading again.
    const signature = bytes.length >= 65 && bytes[0] === 1 ? bs58.encode(bytes.subarray(1, 65)) : undefined;
    onStage("sending", built);
    let sent: { signature: string };
    let uncertain = false;
    try {
      sent = await postSend({
        transaction: toBase64(bytes),
        speed: settings.speed,
        mevProtect: settings.mevProtect,
        ...(built.buildToken ? { buildToken: built.buildToken } : {}),
      });
    } catch (e) {
      // Trading turned off after the click: refresh the session. Nothing went out.
      if (e instanceof ApiError && e.status === 404) {
        tradingUnavailable();
        throw new TradeError(TRADING_OFF);
      }
      // The API refused it before Sender, or Sender refused it: nothing went out. Only the API's own
      // word counts (a proxy's 502 during a restart could follow a send). A slippage miss here was
      // refused, not landed, so it stays distinct from one the chain reverted.
      const notSent =
        e instanceof ApiError &&
        ((e.body as { notSent?: unknown } | null)?.notSent === true || [401, 403].includes(e.status));
      if (notSent) {
        if (e instanceof ApiError && slippageMiss(e.message)) throw new TradeError(SLIPPAGE_UNSENT);
        throw e;
      }
      // The connection dropped, or /send sat unanswered. The signature may be on its way. Watch it
      // before saying so: a landing is a fill or a revert, not a timeout, and not a second submit.
      if (!signature)
        throw new TradeError(
          "Lost touch with the server while sending. It may still land: check your wallet before trading again.",
        );
      uncertain = true;
      sent = { signature };
    }
    sentOut = true;
    markLive(asked.owner, slot, sent.signature);
    onStage("confirming", built);
    try {
      const confirmed = await confirmTrade(sent.signature, uncertain, asked.side);
      clearSlot(asked.owner, slot);
      return confirmed;
    } catch (e) {
      // Status 404 after a successful send: the signature stays, and it may still have landed.
      if (e instanceof ApiError && e.status === 404) {
        tradingUnavailable();
        watchLive(asked.owner, slot, sent.signature);
        throw new TradeError(STATUS_MAYBE, sent.signature);
      }
      if (e instanceof TradeError && e.settled) clearSlot(asked.owner, slot);
      else watchLive(asked.owner, slot, sent.signature);
      throw e;
    }
  } catch (e) {
    if (!sentOut) releaseUnsent(input.owner, slot);
    throw e;
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
