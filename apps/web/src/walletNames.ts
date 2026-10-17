import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ApiError, post } from "./api";
import { shortAddress } from "./format";

/**
 * The names holder and wallet lists show in place of an address (POST /wallets/names): a KOL's
 * name, else Helius's identity name, else TrenchScanner's exchange label. A Pump.fun username
 * shows in quotes ("NAME"), tinted light green (the `pumpfun-name` class in styles.css). Each list asks once for
 * the wallets it shows that aren't known yet; answers are kept for the session, so a list opened
 * again (or another list with the same wallets) asks nothing.
 */

export interface WalletName {
  name: string;
  /** "kol-side": a KOL's Known Side, named "<KOL> Known Side". */
  source: "kol" | "kol-side" | "identity" | "pumpfun" | "fomo" | "exchange";
  /** An exchange or launchpad wallet, whatever name it goes by (absent from older API builds). */
  service?: boolean;
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
    const res = await post<{ names?: Record<string, WalletName>; unread?: string[] }>("/wallets/names", {
      wallets: ask,
    });
    // A wallet the API didn't get to read this time (its budget ran out) isn't "no name": it is
    // left unknown, so the list asks again the next time it opens.
    const unread = new Set(res.unread ?? []);
    for (const w of ask) if (!unread.has(w)) known.set(w, res.names?.[w] ?? null);
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

/** Whether a name is a Pump.fun username: shown quoted, with the `pumpfun-name` class. */
export const isPumpfunName = (n: WalletName | null | undefined): boolean => n?.source === "pumpfun";

/** Whether a name is a FOMO app username: shown quoted, with the `fomo-name` class (purple). */
export const isFomoName = (n: WalletName | null | undefined): boolean => n?.source === "fomo";

/** Whether a name is an app username (Pump.fun or FOMO), which shows in quotes. */
export const isUsername = (n: WalletName | null | undefined): boolean => isPumpfunName(n) || isFomoName(n);

/** A name as the dashboard shows it: a Pump.fun or FOMO username in quotes ("NAME"), any other as it is. */
export function walletNameText(n: WalletName): string {
  return isUsername(n) ? `"${n.name}"` : n.name;
}

/** A wallet as plain text: its name when it has one (see walletNameText), else its short address. */
export function walletText(wallet: string | null | undefined, names?: WalletNames): string {
  if (!wallet) return "";
  const n = names?.[wallet];
  return n ? walletNameText(n) : shortAddress(wallet);
}

/** The name sources that are off by default (user ask 2026-10-16): Pump.fun, FOMO and Helius. */
export type SwitchableSource = "pumpfun" | "fomo" | "identity";
export const SWITCHABLE_NAMES: ReadonlySet<WalletName["source"]> = new Set<SwitchableSource>([
  "pumpfun",
  "fomo",
  "identity",
]);

/** The Settings that show the switchable names: one for all, or each kind on its own (null: the one). */
export interface NameSettings {
  bubbleNameLabels: boolean;
  bubbleNamesPumpfun: boolean | null;
  bubbleNamesFomo: boolean | null;
  bubbleNamesHelius: boolean | null;
}

/**
 * `names` without the Pump.fun, FOMO and Helius names their settings hide: off by default. KOLs',
 * Known Sides' and exchanges' names always show, as do those of the wallets in `keep` (on the
 * bubble map, an exchange that funded holders keeps its Helius name). `all` stands in for
 * bubbleNameLabels where a view has its own switch for it. Returns `names` itself when none is hidden.
 */
export function visibleNames(
  names: WalletNames,
  look: NameSettings,
  all: boolean = look.bubbleNameLabels,
  keep: ReadonlySet<string> = new Set(),
): WalletNames {
  const shows: Record<SwitchableSource, boolean> = {
    pumpfun: look.bubbleNamesPumpfun ?? all,
    fomo: look.bubbleNamesFomo ?? all,
    identity: look.bubbleNamesHelius ?? all,
  };
  const hidden = Object.keys(names).filter((w) => {
    const source = names[w]!.source;
    return SWITCHABLE_NAMES.has(source) && !keep.has(w) && !shows[source as SwitchableSource];
  });
  if (hidden.length === 0) return names;
  const kept: Record<string, WalletName> = { ...names };
  for (const w of hidden) delete kept[w];
  return kept;
}

/** For tests: forget every answer. */
export function resetWalletNames() {
  known.clear();
  asking.clear();
  closed = false;
  notify();
}
