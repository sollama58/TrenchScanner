import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { BurnBalance } from "./burn";

/** The signed-in wallet's SOL and $ASDFASDFA (GET /subscription/balance), and a way to read it again. */
export interface WalletBalance {
  balance: BurnBalance | null;
  error: string | null;
  reload: () => void;
}

/**
 * Read once on mount and on reload(). Settings' Subscription section shares one reading with its
 * burn panel, so a buy or a burn refreshes both. `enabled` false: nothing is read (the burn panel
 * was handed a reading instead).
 */
export function useWalletBalance(enabled = true): WalletBalance {
  const [balance, setBalance] = useState<BurnBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setError(null);
    api<BurnBalance>("/subscription/balance")
      .then((b) => live && setBalance(b))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [enabled, key]);
  const reload = useCallback(() => setKey((k) => k + 1), []);
  return { balance, error, reload };
}
