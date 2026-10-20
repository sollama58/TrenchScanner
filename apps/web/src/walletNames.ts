import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ApiError, post } from "./api";
import { shortAddress } from "./format";

/**
 * The names holder and wallet lists show in place of an address (POST /wallets/names): a KOL's
 * name, else Helius's identity name, else TrenchScanner's exchange label. A Pump.fun username
 * shows in quotes ("NAME"), tinted light green (the `pumpfun-name` class in styles.css). Each list asks once for
 * the wallets it shows that aren't known yet; answers are kept for NAME_TTL_MS (a "no name" for
 * NO_NAME_TTL_MS), so a list opened again (or another list with the same wallets) asks nothing
 * until then. An older answer still shows while it is asked again.
 */

export interface WalletName {
  name: string;
  /**
   * "kol-side": a KOL's Known Side, named "<KOL> Known Side". "tracked": a wallet the reader
   * labeled as User Tracked (a label marked KOL comes as "kol"), for them alone.
   */
  source: "kol" | "kol-side" | "identity" | "pumpfun" | "fomo" | "exchange" | "tracked";
  /** An exchange or launchpad wallet, whatever name it goes by (absent from older API builds). */
  service?: boolean;
  /** The reader's own label (Settings > Labeled wallets), which they can edit. */
  mine?: boolean;
  /** A KOL's X picture, as a path on the API (absent: none, or an older API build). */
  avatar?: string;
}

/** Wallet to name, for the wallets that have one. */
export type WalletNames = Readonly<Record<string, WalletName>>;

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The API's most wallets per read. */
const MAX_PER_READ = 200;

/** How long a name is trusted before a list asks again: a KOL or a label can be renamed. */
export const NAME_TTL_MS = 30 * 60_000;
/** A "no name" answer, shorter: a wallet gets a name (a label, a Pump.fun username) more often than it loses one. */
export const NO_NAME_TTL_MS = 10 * 60_000;

/**
 * Answers so far: a name, or null for a wallet with none, and when it was read; `own` for an
 * answer read without Helius (TrenchScanner's own names only).
 */
const known = new Map<string, { name: WalletName | null; at: number; own?: true }>();

/**
 * Whether `w`'s answer is missing or old enough to ask again. A list that reads Helius's names
 * asks again for a wallet whose "no name" came from TrenchScanner's own names only.
 */
function due(w: string, now: number, identity: boolean): boolean {
  const k = known.get(w);
  if (identity && k?.own && !k.name) return true;
  return !k || now - k.at >= (k.name ? NAME_TTL_MS : NO_NAME_TTL_MS);
}
const asking = new Set<string>();
/**
 * A wallet the API didn't read yet (its few misses wait up to a minute to share one Helius call,
 * or the budget ran out) is asked again this long after, at most UNREAD_RETRIES times in a row.
 */
export const UNREAD_RETRY_MS = 65_000;
const UNREAD_RETRIES = 3;
/**
 * Past UNREAD_RETRIES, a wallet rests this long, then its count starts over and it is asked again:
 * stopping for good left a list open for an hour without the names a busy minute had queued.
 */
export const UNREAD_COOLDOWN_MS = 5 * 60_000;
const retries = new Map<string, number>();
/** Wallets resting out UNREAD_COOLDOWN_MS, so a list asking meanwhile doesn't start a second wait. */
const cooling = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
/** Set once the API says this visitor can't read names (a guest), so lists stop asking. */
let closed = false;
/**
 * A read that failed (a 429 on a busy minute, a dropped connection) is asked again this long after,
 * doubling up to FAILED_RETRY_MAX_MS, six times in a row at most. Before, it waited for the list's
 * wallets to change, which a chart's few KOLs never did, so their names and pictures never came
 * (user report 2026-10-20).
 */
export const FAILED_RETRY_MS = 4_000;
const FAILED_RETRY_MAX_MS = 60_000;
let failedInARow = 0;

function notify() {
  version += 1;
  for (const l of listeners) l();
}

/**
 * Asks the API for the names of `wallets` that aren't known yet or are due again, the first
 * MAX_PER_READ of them in the order given (a live list puts its newest traders first). `identity`
 * false: TrenchScanner's own names only, no Helius read (user ask 2026-10-20: Helius's names
 * rarely matter on the long lists, the live traders and the chart).
 */
export async function loadWalletNames(wallets: readonly string[], identity = true): Promise<void> {
  if (closed) return;
  const now = Date.now();
  const ask = wallets.filter((w) => due(w, now, identity) && !asking.has(w)).slice(0, MAX_PER_READ);
  if (ask.length === 0) return;
  for (const w of ask) asking.add(w);
  try {
    const res = await post<{ names?: Record<string, WalletName>; unread?: string[] }>("/wallets/names", {
      wallets: ask,
      ...(identity ? {} : { identity: false }),
    });
    // A wallet the API didn't get to read this time (queued for the next batch, or its budget ran
    // out) isn't "no name": it is left unknown and asked again shortly, or when the list opens again.
    const unread = new Set(res.unread ?? []);
    const at = Date.now();
    for (const w of ask) {
      if (unread.has(w)) continue;
      known.set(w, { name: res.names?.[w] ?? null, at, ...(identity ? {} : { own: true as const }) });
      retries.delete(w);
    }
    failedInARow = 0;
    notify();
    const again = [...unread].filter((w) => (retries.get(w) ?? 0) < UNREAD_RETRIES);
    for (const w of again) retries.set(w, (retries.get(w) ?? 0) + 1);
    if (again.length > 0) setTimeout(() => void loadWalletNames(again), UNREAD_RETRY_MS);
    const rest = [...unread].filter((w) => (retries.get(w) ?? 0) >= UNREAD_RETRIES && !again.includes(w));
    const resting = rest.filter((w) => !cooling.has(w));
    for (const w of resting) cooling.add(w);
    if (resting.length > 0) {
      setTimeout(() => {
        for (const w of resting) {
          cooling.delete(w);
          retries.delete(w);
        }
        void loadWalletNames(resting);
      }, UNREAD_COOLDOWN_MS);
    }
  } catch (err) {
    // No access means never; anything else is asked again shortly.
    if (err instanceof ApiError && (err.status === 401 || err.status === 402 || err.status === 403))
      closed = true;
    else if (failedInARow < 6) {
      const wait = Math.min(FAILED_RETRY_MAX_MS, FAILED_RETRY_MS * 2 ** failedInARow);
      failedInARow += 1;
      setTimeout(() => void loadWalletNames(ask, identity), wait);
    }
  } finally {
    for (const w of ask) asking.delete(w);
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * The names of `wallets`, read in one batch for those not known yet. Asked in the order given, so
 * a list longer than one read gets its first wallets' names first. `identity` false: TrenchScanner's
 * own names only, for the long lists (loadWalletNames).
 */
export function useWalletNames(
  wallets: readonly (string | null | undefined)[],
  { identity = true }: { identity?: boolean } = {},
): WalletNames {
  const key = useMemo(
    () => [...new Set(wallets.filter((w): w is string => !!w && ADDRESS_RE.test(w)))].join(","),
    [wallets],
  );
  const v = useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (key) void loadWalletNames(key.split(","), identity);
  }, [key, identity]);
  return useMemo(() => {
    const out: Record<string, WalletName> = {};
    if (!key) return out;
    for (const w of key.split(",")) {
      const n = known.get(w)?.name;
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

/**
 * Forgets the answers for `wallets` (the reader just labeled, renamed or unlabeled them), so every
 * open list asks again; null forgets every answer.
 */
export function forgetWalletNames(wallets: readonly string[] | null): void {
  if (wallets === null) known.clear();
  else for (const w of wallets) known.delete(w);
  notify();
}

/**
 * `names` without the reader's own labels, for anything that leaves their screen (share images):
 * labels are private to the reader (user ask 2026-10-18). Returns `names` itself when none is theirs.
 */
export function publicNames(names: WalletNames): WalletNames {
  const mine = Object.keys(names).filter((w) => names[w]!.mine);
  if (mine.length === 0) return names;
  const kept: Record<string, WalletName> = { ...names };
  for (const w of mine) delete kept[w];
  return kept;
}

/** Whether a name stands with the KOLs on the map: a KOL, or a wallet the reader tracks. */
export const isKolLike = (n: WalletName | null | undefined): boolean =>
  n?.source === "kol" || n?.source === "tracked";

/** For tests: forget every answer. */
export function resetWalletNames() {
  known.clear();
  asking.clear();
  retries.clear();
  cooling.clear();
  closed = false;
  notify();
}
