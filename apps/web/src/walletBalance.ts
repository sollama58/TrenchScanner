import { useCallback, useEffect, useState } from "react";
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
 * Read on mount, on reload(), every BALANCE_POLL_MS while the page is visible, and on coming back
 * to a page whose reading is older than that. A failed read keeps the last balances (with
 * `error` set, so they can be shown as old). Settings' Subscription section shares one reading
 * with its burn panel, so a buy or a burn refreshes both. `enabled` false: nothing is read (the
 * burn panel was handed a reading instead).
 */
export function useWalletBalance(enabled = true): WalletBalance {
  const [balance, setBalance] = useState<BurnBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api<BurnBalance>("/subscription/balance")
      .then((b) => {
        if (!live) return;
        setBalance(b);
        setAt(Date.now());
        setError(null);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [enabled, key]);
  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    const again = () => {
      last = Date.now();
      setKey((k) => k + 1);
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") again();
    }, BALANCE_POLL_MS);
    const onShow = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= BALANCE_POLL_MS) again();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [enabled]);
  const reload = useCallback(() => setKey((k) => k + 1), []);
  return { balance, error, at, reload };
}
