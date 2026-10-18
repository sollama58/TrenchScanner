import { useEffect, useSyncExternalStore } from "react";
import { ApiError, api, del, post, put } from "./api";
import { invalidate } from "./cache";
import { forgetPossibleSides } from "./possibleSides";
import { forgetWalletNames } from "./walletNames";

/**
 * The reader's labeled wallets (user ask 2026-10-18; apps/api/src/trackedWallets.ts): Pro Mode
 * only, at most `cap`. A wallet labeled KOL shows with the KOLs, any other as User Tracked, in
 * names, bubble maps, side ties and chart marks, for this reader alone. Read once per session and
 * kept here; every change re-reads the names and side ties the open lists show.
 */

export interface TrackedWallet {
  wallet: string;
  name: string;
  category: "kol" | "tracked";
  createdAt: string;
  updatedAt: string;
}

export interface TrackedState {
  /** Whether the reader has Pro Mode now: labels are added and edited only then. */
  pro: boolean;
  cap: number;
  nameMax: number;
  /** Newest first. */
  wallets: TrackedWallet[];
}

let state: TrackedState | null = null;
let loading: Promise<void> | null = null;
/** Set once the API refuses this visitor the list (a guest, no access), so views stop asking. */
let closed = false;
let version = 0;
const listeners = new Set<() => void>();

function set(next: TrackedState | null) {
  state = next;
  version += 1;
  for (const l of listeners) l();
}

/** Reads the list (again with `force`); a failure leaves what was there. */
export function loadTracked(force = false): Promise<void> {
  if (loading && !force) return loading;
  if (closed && !force) return Promise.resolve();
  loading = api<TrackedState>("/wallets/tracked", { cache: "no-store" })
    .then((s) => set(s))
    .catch((err: unknown) => {
      if (err instanceof ApiError && (err.status === 401 || err.status === 402 || err.status === 403))
        closed = true;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The reader's labels, read on first use; null until read (or when it can't be). */
export function useTrackedWallets(): TrackedState | null {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (!state) void loadTracked();
  }, []);
  return state;
}

/** Every open list's names and side ties re-read, after a label changed. */
function refreshViews(wallet: string) {
  forgetWalletNames([wallet]);
  forgetPossibleSides();
}

/** Adds or renames a label; throws the API's message (over the cap, no Pro Mode) on refusal. */
export async function saveTrackedWallet(wallet: string, name: string, kol: boolean): Promise<TrackedWallet> {
  const res = await put<{ wallet: TrackedWallet }>(`/wallets/tracked/${encodeURIComponent(wallet)}`, {
    name,
    kol,
  });
  if (state) {
    const rest = state.wallets.filter((w) => w.wallet !== wallet);
    const had = state.wallets.find((w) => w.wallet === wallet);
    set({
      ...state,
      wallets: had ? state.wallets.map((w) => (w.wallet === wallet ? res.wallet : w)) : [res.wallet, ...rest],
    });
  } else void loadTracked(true);
  refreshViews(wallet);
  return res.wallet;
}

export interface ImportResult {
  added: number;
  updated: number;
  /** New wallets left out because the list reached its cap. */
  overCap: number;
  /** Entries whose name was empty once cleaned. */
  unnamed: number;
}

/** Adds or renames many labels at once (a JSON list, see trackedImport.ts), then re-reads the list. */
export async function importTrackedWallets(
  wallets: readonly { wallet: string; name: string; kol: boolean }[],
): Promise<ImportResult> {
  const res = await post<ImportResult>("/wallets/tracked/import", { wallets });
  await loadTracked(true);
  forgetWalletNames(wallets.map((w) => w.wallet));
  forgetPossibleSides();
  return res;
}

/** Removes a label. */
export async function removeTrackedWallet(wallet: string): Promise<void> {
  await del<{ removed: boolean }>(`/wallets/tracked/${encodeURIComponent(wallet)}`);
  if (state) set({ ...state, wallets: state.wallets.filter((w) => w.wallet !== wallet) });
  refreshViews(wallet);
}

/** A refusal's text for the reader. */
export function trackedError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

let account: string | null = null;

/**
 * The signed-in account, set on every render of the app: a different one (or none) forgets the
 * list and every name and side tie read under the last, which carried its labels.
 */
export function setTrackedAccount(wallet: string | null, pro: boolean): void {
  const key = wallet ? `${wallet}:${pro ? 1 : 0}` : null;
  if (key === account) return;
  const first = account === null && state === null;
  account = key;
  if (first) return;
  resetTracked();
  forgetWalletNames(null);
  forgetPossibleSides();
  // The wallet views and charts read under the last account carried its labels too.
  invalidate("/wallets/");
  invalidate("/tokens/");
}

/** For tests and sign-out: forget the list. */
export function resetTracked(): void {
  loading = null;
  closed = false;
  set(null);
}
