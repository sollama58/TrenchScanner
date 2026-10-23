import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, ApiError, del, post, put } from "./api";
import { isGuest } from "./session";

/**
 * The Watchlist (user ask 2026-10-23): tokens starred on an alert card, a Scope row, the token view
 * or the Utilities tab, saved to the account (/watchlist) and shown by WatchlistPanel (the Live
 * tab's market bar), WatchlistChips (its collapsed form) and WatchlistManager (Utilities), with
 * their market cap now and their change since they were added. At most WATCHLIST_CAP tokens.
 *
 * One store for the page: every star reads whether its token is watched from here, so a card
 * re-renders only when its own star changes, and the list is fetched once however many cards are
 * on screen. It loads when the first star or panel mounts, and polls every WATCHLIST_POLL_MS while
 * a panel is mounted and the page is visible. A change shows at once (optimistically) and is put
 * back if the save fails. apps/api/src/watchlist.ts holds the same names and bounds.
 */

export interface WatchlistItem {
  tokenId: string;
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  addedAt: string;
  addedMarketCapUsd: number | null;
  addedPriceUsd: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  /** When the market cap was read; null when the token has no reading. */
  at: string | null;
  /** Market cap change since it was added, in percent. */
  changeSinceAddedPct: number | null;
  /** The newest scan's 1h and 24h price changes, as of `changeAt`. */
  priceChange1hPct: number | null;
  priceChange24hPct?: number | null;
  changeAt: string | null;
}

/** What a star knows of its token: enough to show it in the panel before the save comes back. */
export interface WatchToken {
  tokenId: string;
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  /** The market cap the card shows now, for the panel until the server's reading lands. */
  marketCapUsd?: number | null;
}

/**
 * idle: not asked yet. loading: the first answer is on its way. ready: loaded. off: this reader
 * has no watchlist (a guest, signed out, or without access) - the stars hide. error: the last
 * load failed; the items are the last ones known.
 */
export type WatchlistStatus = "idle" | "loading" | "ready" | "off" | "error";

export interface WatchlistState {
  status: WatchlistStatus;
  items: WatchlistItem[];
  cap: number;
  /** A short message about the last change that couldn't be saved; cleared after a few seconds. */
  notice: string | null;
}

/** Tokens one account may watch at most (user decision 2026-10-23). */
export const WATCHLIST_CAP = 10;
export const WATCHLIST_POLL_MS = 30_000;
/** How long the store keeps the list once nothing on the page shows it (a tab switch, a sign-out). */
const FORGET_AFTER_MS = 3_000;
const NOTICE_MS = 4_000;

export const fullText = (cap: number) => `Watchlist is full (${cap})`;

const INITIAL: WatchlistState = { status: "idle", items: [], cap: WATCHLIST_CAP, notice: null };

let state: WatchlistState = INITIAL;
/** Saves on their way, by token: a poll that lands meanwhile must not undo them on screen. */
const pending = new Map<string, { op: "add"; item: WatchlistItem } | { op: "remove" }>();
/** An order (or a clear) on its way: polls answer with the old one until it lands. */
let pendingOrder: string[] | null = null;
const listeners = new Set<() => void>();
let loadSeq = 0;
let forgetTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let pollers = 0;

function set(next: Partial<WatchlistState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (forgetTimer) {
    clearTimeout(forgetTimer);
    forgetTimer = null;
  }
  if (state.status === "idle") void loadWatchlist();
  return () => {
    listeners.delete(listener);
    // Nothing shows it any more: forget it shortly, so a sign-out or another account signing in
    // never shows the last account's stars. A tab switch back reloads it.
    if (listeners.size === 0 && !forgetTimer) {
      forgetTimer = setTimeout(() => {
        forgetTimer = null;
        if (listeners.size === 0) resetWatchlist();
      }, FORGET_AFTER_MS);
    }
  };
}

/** `items` in `order` (ids it names first, the rest after in their own order). */
function ordered(items: WatchlistItem[], order: readonly string[]): WatchlistItem[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...items].sort((a, b) => (rank.get(a.tokenId) ?? 1e9) - (rank.get(b.tokenId) ?? 1e9));
}

/** The server's list with the saves still on their way laid over it. */
function withPending(items: WatchlistItem[]): WatchlistItem[] {
  let out = items;
  if (pending.size > 0) {
    out = out.filter((i) => pending.get(i.tokenId)?.op !== "remove");
    const have = new Set(out.map((i) => i.tokenId));
    const added: WatchlistItem[] = [];
    for (const [tokenId, p] of pending) if (p.op === "add" && !have.has(tokenId)) added.push(p.item);
    out = [...added, ...out];
  }
  return pendingOrder ? ordered(out, pendingOrder) : out;
}

function isOff(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 402 || e.status === 403);
}

function adopt(res: { cap?: number; items?: WatchlistItem[] }) {
  set({
    status: "ready",
    items: withPending(Array.isArray(res.items) ? res.items : []),
    cap: typeof res.cap === "number" && res.cap > 0 ? res.cap : WATCHLIST_CAP,
  });
}

/** Reads the account's list now. A guest has none, and doesn't ask (a 401 would sign the page out). */
export async function loadWatchlist(): Promise<void> {
  if (isGuest()) {
    set({ status: "off", items: [] });
    return;
  }
  const mine = ++loadSeq;
  if (state.status === "idle") set({ status: "loading" });
  try {
    const res = await api<{ cap?: number; items?: WatchlistItem[] }>("/watchlist");
    if (mine !== loadSeq) return;
    adopt(res);
  } catch (e) {
    if (mine !== loadSeq) return;
    if (isOff(e)) set({ status: "off", items: [] });
    else set({ status: state.items.length > 0 || state.status === "ready" ? "ready" : "error" });
  }
}

/** Forgets the list (sign-out); the next star or panel to mount loads it again. */
export function resetWatchlist(): void {
  loadSeq++;
  pending.clear();
  pendingOrder = null;
  set(INITIAL);
}

function flash(notice: string) {
  if (noticeTimer) clearTimeout(noticeTimer);
  set({ notice });
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    set({ notice: null });
  }, NOTICE_MS);
}

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.status === 409)
    return `${fullText(state.cap)}. Remove a token to add another.`;
  return e instanceof Error && e.message ? `${fallback}: ${e.message}` : fallback;
}

export function isWatchedIn(s: WatchlistState, tokenId: string): boolean {
  return s.items.some((i) => i.tokenId === tokenId);
}

export function isFull(s: WatchlistState): boolean {
  return s.items.length >= s.cap;
}

/** Stars `token` on top of the list, keeping its place until the save answers. */
export async function watchToken(token: WatchToken): Promise<void> {
  if (state.status === "off" || isWatchedIn(state, token.tokenId) || pending.has(token.tokenId)) return;
  if (isFull(state)) {
    flash(`${fullText(state.cap)}. Remove a token to add another.`);
    return;
  }
  const cap = token.marketCapUsd != null && token.marketCapUsd > 0 ? token.marketCapUsd : null;
  const optimistic: WatchlistItem = {
    tokenId: token.tokenId,
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    imageUrl: token.imageUrl,
    addedAt: new Date().toISOString(),
    addedMarketCapUsd: cap,
    addedPriceUsd: null,
    marketCapUsd: cap,
    priceUsd: null,
    at: cap === null ? null : new Date().toISOString(),
    changeSinceAddedPct: cap === null ? null : 0,
    priceChange1hPct: null,
    priceChange24hPct: null,
    changeAt: null,
  };
  pending.set(token.tokenId, { op: "add", item: optimistic });
  if (pendingOrder) pendingOrder = [token.tokenId, ...pendingOrder];
  set({ items: [optimistic, ...state.items] });
  try {
    const res = await post<{ item: WatchlistItem }>("/watchlist", { tokenId: token.tokenId });
    if (pending.get(token.tokenId)?.op !== "add") return;
    pending.delete(token.tokenId);
    set({ items: state.items.map((i) => (i.tokenId === token.tokenId ? res.item : i)) });
  } catch (e) {
    if (pending.get(token.tokenId)?.op !== "add") return;
    pending.delete(token.tokenId);
    set({ items: state.items.filter((i) => i.tokenId !== token.tokenId) });
    if (isOff(e)) set({ status: "off", items: [] });
    else flash(errorText(e, "Couldn't add it to your watchlist"));
  }
}

/**
 * Stars a token by its contract address (the Utilities tab's search), once the server has it: no
 * optimistic row, since only the server knows the coin. Resolves to an error message, or null.
 */
export async function watchMint(mint: string): Promise<string | null> {
  if (state.status === "off") return "Sign in with access to keep a watchlist.";
  if (state.items.some((i) => i.mint === mint)) return null;
  if (isFull(state)) return `${fullText(state.cap)}. Remove a token to add another.`;
  try {
    const res = await post<{ item: WatchlistItem }>("/watchlist", { mint });
    if (!isWatchedIn(state, res.item.tokenId)) {
      if (pendingOrder) pendingOrder = [res.item.tokenId, ...pendingOrder];
      set({ items: [res.item, ...state.items] });
    }
    return null;
  } catch (e) {
    if (isOff(e)) set({ status: "off", items: [] });
    return errorText(e, "Couldn't add it to your watchlist");
  }
}

/** Unstars a token, putting it back where it was if the save fails. */
export async function unwatchToken(tokenId: string): Promise<void> {
  const index = state.items.findIndex((i) => i.tokenId === tokenId);
  if (index < 0 || pending.get(tokenId)?.op === "remove") return;
  const item = state.items[index]!;
  pending.set(tokenId, { op: "remove" });
  set({ items: state.items.filter((i) => i.tokenId !== tokenId) });
  try {
    await del(`/watchlist/${encodeURIComponent(tokenId)}`);
    if (pending.get(tokenId)?.op === "remove") pending.delete(tokenId);
  } catch (e) {
    if (pending.get(tokenId)?.op !== "remove") return;
    pending.delete(tokenId);
    if (isOff(e)) {
      set({ status: "off", items: [] });
      return;
    }
    const items = [...state.items];
    items.splice(Math.min(index, items.length), 0, item);
    set({ items });
    flash(errorText(e, "Couldn't remove it from your watchlist"));
  }
}

/** Stars or unstars `token`. */
export function toggleWatch(token: WatchToken): void {
  if (isWatchedIn(state, token.tokenId)) void unwatchToken(token.tokenId);
  else void watchToken(token);
}

/** Puts the list in `tokenIds`' order, at once, and back if the save fails. */
export async function reorderWatchlist(tokenIds: string[]): Promise<void> {
  if (state.status !== "ready" || tokenIds.length === 0) return;
  const before = state.items;
  pendingOrder = tokenIds;
  set({ items: ordered(state.items, tokenIds) });
  try {
    const res = await put<{ cap?: number; items?: WatchlistItem[] }>("/watchlist/order", { tokenIds });
    if (pendingOrder !== tokenIds) return;
    pendingOrder = null;
    adopt(res);
  } catch (e) {
    if (pendingOrder !== tokenIds) return;
    pendingOrder = null;
    if (isOff(e)) {
      set({ status: "off", items: [] });
      return;
    }
    set({ items: before });
    flash(errorText(e, "Couldn't save the new order"));
  }
}

/** Moves a token `by` places (-1 up, 1 down). */
export function moveWatched(tokenId: string, by: number): void {
  const ids = state.items.map((i) => i.tokenId);
  const from = ids.indexOf(tokenId);
  const to = from + by;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]!);
  void reorderWatchlist(ids);
}

/** Unstars everything, putting the list back if the save fails. */
export async function clearWatchlist(): Promise<void> {
  if (state.items.length === 0) return;
  const before = state.items;
  const ids = before.map((i) => i.tokenId);
  for (const id of ids) pending.set(id, { op: "remove" });
  set({ items: [] });
  try {
    await del("/watchlist");
  } catch (e) {
    if (isOff(e)) {
      for (const id of ids) pending.delete(id);
      set({ status: "off", items: [] });
      return;
    }
    set({ items: before });
    flash(errorText(e, "Couldn't clear your watchlist"));
  } finally {
    for (const id of ids) if (pending.get(id)?.op === "remove") pending.delete(id);
  }
}

let stopPolling = () => {};

function startPolling(): () => void {
  pollers++;
  if (pollers === 1) {
    const tick = () => {
      if (document.visibilityState === "visible" && state.status !== "off") void loadWatchlist();
    };
    const timer = setInterval(tick, WATCHLIST_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    stopPolling = () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
    // A panel mounting on a list loaded a while ago (by the stars) shows today's figures.
    if (state.status === "ready" || state.status === "error") void loadWatchlist();
  }
  return () => {
    pollers--;
    if (pollers === 0) stopPolling();
  };
}

const getState = () => state;
const isAvailable = () => state.status !== "off";
const isFullNow = () => isFull(state);

/** The whole watchlist, kept fresh (polled) while the calling component is mounted. */
export function useWatchlist(): WatchlistState & {
  isWatched: (tokenId: string) => boolean;
  toggleWatch: (token: WatchToken) => void;
  unwatch: (tokenId: string) => void;
} {
  const s = useSyncExternalStore(subscribe, getState, getState);
  useEffect(() => startPolling(), []);
  const isWatched = useCallback((tokenId: string) => isWatchedIn(s, tokenId), [s]);
  return { ...s, isWatched, toggleWatch, unwatch: (tokenId: string) => void unwatchToken(tokenId) };
}

/**
 * Whether `tokenId` is watched, whether this reader has a watchlist at all, and whether it is full
 * (for a star).
 */
export function useWatchStar(tokenId: string): { watched: boolean; available: boolean; full: boolean } {
  const watchedNow = () => isWatchedIn(state, tokenId);
  const watched = useSyncExternalStore(subscribe, watchedNow, watchedNow);
  const available = useSyncExternalStore(subscribe, isAvailable, isAvailable);
  const full = useSyncExternalStore(subscribe, isFullNow, isFullNow);
  return { watched, available, full };
}
