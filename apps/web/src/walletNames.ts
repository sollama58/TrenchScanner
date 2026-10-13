import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ApiError, post } from "./api";
import { shortAddress } from "./format";

/**
 * The names holder and wallet lists show in place of an address (POST /wallets/names): a KOL's
 * name, else Helius's identity name, else TrenchScanner's exchange label. Each list asks once for
 * the wallets it shows that aren't known yet; answers are kept for the session, so a list opened
 * again (or another list with the same wallets) asks nothing.
 */

export interface WalletName {
  name: string;
  source: "kol" | "identity" | "exchange";
}

/** Wallet to name, for the wallets that have one. */
export type WalletNames = Readonly<Record<string, WalletName>>;

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The API's most wallets per read. */
const MAX_PER_READ = 200;

/** Answers so far: a name, or null for a wallet with none. */
const known = new Map<string, WalletName | null>();
const asking = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
/** Set once the API says this visitor can't read names (a guest), so lists stop asking. */
let closed = false;

function notify() {
  version += 1;
  for (const l of listeners) l();
}

async function load(wallets: readonly string[]) {
  if (closed) return;
  const ask = wallets.filter((w) => !known.has(w) && !asking.has(w)).slice(0, MAX_PER_READ);
  if (ask.length === 0) return;
  for (const w of ask) asking.add(w);
  try {
    const res = await post<{ names?: Record<string, WalletName> }>("/wallets/names", { wallets: ask });
    for (const w of ask) known.set(w, res.names?.[w] ?? null);
    notify();
  } catch (err) {
    // A failed read is asked again next time the list opens; no access means never.
    if (err instanceof ApiError && (err.status === 401 || err.status === 402 || err.status === 403))
      closed = true;
  } finally {
    for (const w of ask) asking.delete(w);
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The names of `wallets`, read in one batch for those not known yet. */
export function useWalletNames(wallets: readonly (string | null | undefined)[]): WalletNames {
  const key = useMemo(
    () => [...new Set(wallets.filter((w): w is string => !!w && ADDRESS_RE.test(w)))].sort().join(","),
    [wallets],
  );
  const v = useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (key) void load(key.split(","));
  }, [key]);
  return useMemo(() => {
    const out: Record<string, WalletName> = {};
    if (!key) return out;
    for (const w of key.split(",")) {
      const n = known.get(w);
      if (n) out[w] = n;
    }
    return out;
    // v changes when a read finishes, so names may have arrived.
  }, [key, v]);
}

/** A wallet as plain text: its name when it has one, else its short address. */
export function walletText(wallet: string | null | undefined, names?: WalletNames): string {
  if (!wallet) return "";
  return names?.[wallet]?.name ?? shortAddress(wallet);
}

/** For tests: forget every answer. */
export function resetWalletNames() {
  known.clear();
  asking.clear();
  closed = false;
  notify();
}
