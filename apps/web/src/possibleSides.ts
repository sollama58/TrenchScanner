import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ApiError, post } from "./api";

/**
 * Possible KOL side wallets (POST /wallets/possible-sides): wallets the Side Wallet Checker found
 * buying more than 90% of a KOL's coins alongside it over the last 24 hours, on more than 25 coins.
 * For the bubble map's ties and tags only. Answers are kept for the session, like wallet names.
 */

export interface PossibleSide {
  kolWallet: string;
  kolName: string | null;
  pct: number;
  shared: number;
  kolCoins: number;
}

export type PossibleSides = Readonly<Record<string, readonly PossibleSide[]>>;

const MAX_PER_READ = 200;
const known = new Map<string, readonly PossibleSide[]>();
const asking = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let closed = false;

async function load(wallets: readonly string[]) {
  if (closed) return;
  const ask = wallets.filter((w) => !known.has(w) && !asking.has(w)).slice(0, MAX_PER_READ);
  if (ask.length === 0) return;
  for (const w of ask) asking.add(w);
  try {
    const res = await post<{ sides?: Record<string, PossibleSide[]> }>("/wallets/possible-sides", {
      wallets: ask,
    });
    for (const w of ask) known.set(w, res.sides?.[w] ?? []);
    version += 1;
    for (const l of listeners) l();
  } catch (err) {
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

/** The possible-side matches of `wallets` that have any. */
export function usePossibleSides(wallets: readonly (string | null | undefined)[]): PossibleSides {
  const key = useMemo(
    () => [...new Set(wallets.filter((w): w is string => !!w))].sort().join(","),
    [wallets],
  );
  const v = useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (key) void load(key.split(","));
  }, [key]);
  return useMemo(() => {
    const out: Record<string, readonly PossibleSide[]> = {};
    if (!key) return out;
    for (const w of key.split(",")) {
      const s = known.get(w);
      if (s && s.length > 0) out[w] = s;
    }
    return out;
    // v changes when a read finishes.
  }, [key, v]);
}

/** "Ansem Possible Side (93%)". */
export function possibleSideText(s: Pick<PossibleSide, "kolWallet" | "kolName" | "pct">): string {
  const who = s.kolName ?? `${s.kolWallet.slice(0, 4)}…${s.kolWallet.slice(-4)}`;
  return `${who} Possible Side (${Math.round(s.pct)}%)`;
}

/** The KOLs with possible side wallets among `holders`, each with those holders, strongest first. */
export function sideGroups(
  holders: readonly string[],
  sides: PossibleSides,
): { kolWallet: string; kolName: string | null; wallets: { wallet: string; pct: number }[] }[] {
  const byKol = new Map<
    string,
    { kolWallet: string; kolName: string | null; wallets: { wallet: string; pct: number }[] }
  >();
  for (const w of holders) {
    for (const s of sides[w] ?? []) {
      let g = byKol.get(s.kolWallet);
      if (!g) byKol.set(s.kolWallet, (g = { kolWallet: s.kolWallet, kolName: s.kolName, wallets: [] }));
      g.wallets.push({ wallet: w, pct: s.pct });
    }
  }
  return [...byKol.values()]
    .map((g) => ({ ...g, wallets: g.wallets.sort((a, b) => b.pct - a.pct) }))
    .sort((a, b) => b.wallets.length - a.wallets.length || b.wallets[0]!.pct - a.wallets[0]!.pct);
}
