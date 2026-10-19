import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ApiError, post } from "./api";

/**
 * Possible KOL side wallets (POST /wallets/possible-sides): wallets the Side Wallet Checker found
 * buying a KOL's coins alongside it: all of them on 10+ coins over 24 hours, 90%+ on 25+ over
 * 48 hours, or 80%+ on 50+ over 72 hours; or that the KOL sent coins to 6 times in 24 hours, 10 in
 * 48 or 25 in 72, or that sent the KOL coins 8 times over 1% of supply in 24 hours, 16 over 0.5% in
 * 24 or 16 over 2% in 72 (user ask 2026-10-16).
 * For the bubble map's ties and tags only. Answers are kept for the session, like wallet names.
 */

export interface PossibleSide {
  kolWallet: string;
  kolName: string | null;
  pct: number;
  shared: number;
  kolCoins: number;
  /** The span the match was read over: 24, 48 or 72 hours (absent from older API builds); 0 when funded only. */
  hours?: number;
  /** The KOL funded this wallet (paid for its first SOL): a KOL Funded Wallet, not a "possible" one. */
  funded?: boolean;
  /** One of the KOL's own wallets (a Known Side: another roster entry of a KOL with a main wallet set). */
  known?: boolean;
  /** Transfers of a coin between it and the KOL that earned the label (core's TRANSFER_SIDE_OUTBOUND_TIERS and TRANSFER_SIDE_INBOUND_TIERS); absent when none. */
  transfers?: number;
  /** A tie to a wallet the reader labeled (shown to them alone): its kind. Absent on the roster's. */
  tracked?: "kol" | "tracked";
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

/**
 * Forgets every answer and asks again (the reader just changed a label): which wallets a label ties
 * to isn't known here, so every open map re-reads its holders.
 */
export function forgetPossibleSides(): void {
  known.clear();
  // A refusal belonged to the last account (a guest who has since signed in, an ended access).
  closed = false;
  version += 1;
  for (const l of listeners) l();
}

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

/** "Ansem Probable Side (93%)", "Ansem KOL Funded Wallet" for a wallet the KOL funded, "Ansem Known Side" for its own. */
export function possibleSideText(
  s: Pick<PossibleSide, "kolWallet" | "kolName" | "pct" | "funded" | "known" | "transfers" | "tracked">,
): string {
  const who = s.kolName ?? `${s.kolWallet.slice(0, 4)}…${s.kolWallet.slice(-4)}`;
  if (s.known) return `${who} Known Side`;
  // A User Tracked wallet is no KOL: "<name> Funded Wallet".
  if (s.funded) return s.tracked === "tracked" ? `${who} Funded Wallet` : `${who} KOL Funded Wallet`;
  // A label transfers alone earned has no buying-alongside share to show (user ask 2026-10-16).
  return s.pct > 0
    ? `${who} Probable Side (${Math.round(s.pct)}%)`
    : `${who} Probable Side (${s.transfers ?? 0} transfers)`;
}

/** `sides` without the ties to the reader's own labeled wallets, for share images (publicNames). */
export function publicSides(sides: PossibleSides): PossibleSides {
  const out: Record<string, readonly PossibleSide[]> = {};
  for (const [w, list] of Object.entries(sides)) {
    const kept = list.filter((s) => !s.tracked);
    if (kept.length > 0) out[w] = kept;
  }
  return out;
}

/** The KOLs with possible side wallets among `holders`, each with those holders, strongest first. */
export function sideGroups(
  holders: readonly string[],
  sides: PossibleSides,
): {
  kolWallet: string;
  kolName: string | null;
  tracked?: boolean;
  wallets: { wallet: string; pct: number; funded: boolean; known: boolean }[];
}[] {
  const byKol = new Map<
    string,
    {
      kolWallet: string;
      kolName: string | null;
      /** A wallet the reader labeled as User Tracked. */
      tracked?: boolean;
      wallets: { wallet: string; pct: number; funded: boolean; known: boolean }[];
    }
  >();
  for (const w of holders) {
    for (const s of sides[w] ?? []) {
      let g = byKol.get(s.kolWallet);
      if (!g)
        byKol.set(
          s.kolWallet,
          (g = {
            kolWallet: s.kolWallet,
            kolName: s.kolName,
            ...(s.tracked === "tracked" ? { tracked: true } : {}),
            wallets: [],
          }),
        );
      g.wallets.push({ wallet: w, pct: s.pct, funded: !!s.funded, known: !!s.known });
    }
  }
  return [...byKol.values()]
    .map((g) => ({
      ...g,
      // Known Sides, then funded wallets first: the confirmed ties.
      wallets: g.wallets.sort(
        (a, b) => Number(b.known) - Number(a.known) || Number(b.funded) - Number(a.funded) || b.pct - a.pct,
      ),
    }))
    .sort((a, b) => b.wallets.length - a.wallets.length || b.wallets[0]!.pct - a.wallets[0]!.pct);
}
