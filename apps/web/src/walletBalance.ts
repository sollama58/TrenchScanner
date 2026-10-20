import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import type { BurnBalance } from "./burn";

/** The signed-in wallet's SOL and $ASDFASDFA (GET /subscription/balance), and a way to read it again. */
export interface WalletBalance {
  balance: BurnBalance | null;
  error: string | null;
  /** When `balance` was read (ms); null before the first answer. */
  at: number | null;
  reload: () => void;
}

/** How often an open, visible page reads the balances again (a buy or a burn elsewhere shows). */
export const BALANCE_POLL_MS = 60_000;
/**
 * While a Pro balance is on screen, the shared reading follows the position poll
 * (POSITION_POLL_MS in proTrade.ts). The idle minute poll stays for Settings and Portfolio.
 * The live trade stream is a trade tape, not a balance, so this does not run any faster.
 */
export const BALANCE_LIVE_MS = 15_000;
/** A reading this fresh answers a panel that opens (Settings, Portfolio) without asking again. */
export const BALANCE_FRESH_MS = 10_000;

type Reading = Pick<WalletBalance, "balance" | "error" | "at">;

/**
 * One reading shared by every open panel (user ask 2026-10-19: the header shows it too), so the
 * header, Settings and Portfolio cost one GET /subscription/balance between them, not one each.
 * Read when the first panel opens, when a panel opens on a reading older than BALANCE_FRESH_MS,
 * on reload(), every BALANCE_POLL_MS while the page is visible (BALANCE_LIVE_MS while a Pro balance
 * is showing), and on coming back to a page whose reading is older than that. A failed read keeps
 * the last balances (with `error` set, so they can be shown as old). Forgotten once the last panel
 * closes (signing out unmounts the header), so the next wallet never sees the last one's.
 */
export class BalanceStore {
  private reading: Reading = { balance: null, error: null, at: null };
  private listeners = new Set<() => void>();
  private users = 0;
  /** Panels that want the position cadence (the Pro header and the Trade panel). */
  private liveUsers = 0;
  /** Bumped on every read and on forget(), so only the newest answer lands. */
  private seq = 0;
  private lastAsked = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listening = false;

  constructor(
    private readonly read: () => Promise<BurnBalance>,
    private readonly now: () => number = Date.now,
    private readonly visible: () => boolean = () =>
      typeof document === "undefined" || document.visibilityState === "visible",
  ) {}

  get = (): Reading => this.reading;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A panel showing the balances opened. `live` follows the position poll. The return closes it. */
  open(live = false): () => void {
    this.users += 1;
    if (live) this.liveUsers += 1;
    this.arm();
    if (this.lastAsked === 0 || this.now() - this.lastAsked >= BALANCE_FRESH_MS) this.reload();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.users -= 1;
      if (live) this.liveUsers -= 1;
      if (this.users === 0) this.forget();
      else this.arm();
    };
  }

  reload = (): void => {
    const seq = ++this.seq;
    this.lastAsked = this.now();
    this.read()
      .then((balance) => {
        if (seq === this.seq) this.set({ balance, error: null, at: this.now() });
      })
      .catch((e: unknown) => {
        if (seq === this.seq)
          this.set({ ...this.reading, error: e instanceof Error ? e.message : String(e) });
      });
  };

  private every(): number {
    return this.liveUsers > 0 ? BALANCE_LIVE_MS : BALANCE_POLL_MS;
  }

  /** One timer for every open panel, at the cadence the open panels asked for. */
  private arm(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.visible()) this.reload();
    }, this.every());
    if (!this.listening && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onShow);
      this.listening = true;
    }
  }

  private onShow = (): void => {
    if (this.visible() && this.now() - this.lastAsked >= this.every()) this.reload();
  };

  private forget(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.liveUsers = 0;
    if (this.listening && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onShow);
      this.listening = false;
    }
    this.seq += 1;
    this.lastAsked = 0;
    this.set({ balance: null, error: null, at: null });
  }

  private set(reading: Reading): void {
    this.reading = reading;
    for (const listener of this.listeners) listener();
  }
}

const shared = new BalanceStore(() => api<BurnBalance>("/subscription/balance"));
const NOTHING: Reading = { balance: null, error: null, at: null };

/**
 * The shared reading (BalanceStore). Settings' Subscription section hands its reading to its burn
 * panel, so a buy or a burn refreshes both, and the header follows along. `enabled` false: this
 * panel neither reads nor shows anything (the burn panel was handed a reading instead). `live`
 * follows the position poll (the Pro header and the Trade panel); other panels keep the minute one.
 */
export function useWalletBalance(enabled = true, live = false): WalletBalance {
  useEffect(() => (enabled ? shared.open(live) : undefined), [enabled, live]);
  const reading = useSyncExternalStore(shared.subscribe, shared.get);
  const reload = useCallback(() => shared.reload(), []);
  return { ...(enabled ? reading : NOTHING), reload };
}

/** SOL for the header: three decimals under 1, two under 100, then one. */
export function compactSol(lamports: string): string {
  const sol = Number(lamports) / 1e9;
  const digits = sol < 1 ? 3 : sol < 100 ? 2 : 1;
  return sol.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** A token amount for the header: 950, 12.4K, 1.23M, 4.5B. */
export function compactTokens(raw: string, decimals: number): string {
  const n = Number(BigInt(raw) / 10n ** BigInt(Math.max(decimals - 2, 0))) / 10 ** Math.min(decimals, 2);
  const [div, suffix] = n >= 1e9 ? [1e9, "B"] : n >= 1e6 ? [1e6, "M"] : n >= 1e3 ? [1e3, "K"] : [1, ""];
  const v = n / div;
  const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toLocaleString("en-US", { maximumFractionDigits: digits })}${suffix}`;
}

/**
 * Whether this wallet's SOL and token balances are shown.
 *
 * The same rule as the token Trade panel: full Pro Mode, and a browser that can sign for that
 * wallet. The server's isPro is an admin, a grant, or a top holder. It is off for everyone, admins
 * included, while PRO_TRADING_ENABLED is off, and off for everyone but admins while
 * PRO_TRADING_PUBLIC is off. A wallet without Pro Mode sees nothing. The in-app $ASDFASDFA buy is
 * open more widely and does not use this.
 */
export function spendBalancesShown(pro: boolean, canSign: boolean): boolean {
  return pro && canSign;
}

/** Compact token and SOL for the token header. A missing read stays a dash, so the row keeps its shape. */
export function headerPairText(input: {
  tokenRaw: string | null;
  decimals: number | null;
  solLamports: string | null;
}): { token: string; sol: string } {
  const token =
    input.tokenRaw !== null && input.decimals !== null ? compactTokens(input.tokenRaw, input.decimals) : "–";
  const sol = input.solLamports !== null ? compactSol(input.solLamports) : "–";
  return { token, sol };
}
