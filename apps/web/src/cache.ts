import { api, parse } from "./api";

/**
 * A small in-memory cache for the dashboard's GET calls, keyed by path.
 *
 * It does three things for load speed: requests started at boot (before React has rendered, see
 * index.html) are picked up by the components that need them instead of being sent
 * again; two views asking for the same path at once share one request; and a tab you come back to
 * paints its last data at once while it refreshes in the background.
 *
 * The first screen's answers are also kept in localStorage, so a returning visitor's reload paints
 * the last feed straight away (dimmed as stale) instead of waiting on the API, then refreshes.
 */
interface Entry {
  data?: unknown;
  /** When `data` arrived (ms). */
  at: number;
  inflight?: Promise<unknown>;
  /** When `inflight` was sent (ms) - see NUDGE_SHARE_MS. */
  inflightAt?: number;
  /** Request number of `data`, so an older request landing late can't overwrite a newer answer. */
  n?: number;
  /** `data` came from localStorage (an earlier visit), not from this page's own requests. */
  restored?: boolean;
}

let requests = 0;

const entries = new Map<string, Entry>();

/** Answers worth keeping between visits: everything a tab paints on open. */
const PERSIST = new Set([
  "/auth/me",
  "/subscription",
  "/health/worker",
  "/matches?page=1&includeCurated=saved",
  "/guest/feed?page=1",
  "/guest/models?days=30",
  "/guest/models?days=7",
  "/guest/insights?days=7",
  "/matches/stats?hours=24",
  "/curated/stats",
  "/curated/models?days=30",
  "/curated/models?days=7",
  "/curated/insights?days=7",
  "/filters",
  "/config",
  "/curated/lighthouse/history?days=30&bucket=day&dimension=category",
  "/guest/lighthouse/history?days=30&bucket=day&dimension=category",
]);
/** The Lighthouse's Right now, whose path ends with the reader's zone (routes.ts lighthousePath). */
const PERSIST_PREFIXES = ["/curated/lighthouse?days=7&", "/guest/lighthouse?days=7&"];
const persisted = (path: string) =>
  PERSIST.has(path) || PERSIST_PREFIXES.some((prefix) => path.startsWith(prefix));
const STORE_KEY = "ts-cache-v1";
/** Older stored answers are dropped rather than shown. */
const STORE_MAX_AGE_MS = 12 * 3600_000;

function restore(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, { data: unknown; at: number }>;
    for (const [path, { data, at }] of Object.entries(saved))
      if (persisted(path) && Date.now() - at < STORE_MAX_AGE_MS)
        entries.set(path, { data, at, restored: true });
  } catch {
    // Storage blocked or corrupt: start empty.
  }
}
restore();

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(): void {
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    const out: Record<string, { data: unknown; at: number }> = {};
    for (const [path, e] of entries)
      if (persisted(path) && e.data !== undefined) out[path] = { data: e.data, at: e.at };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch {
      // Full or blocked: the in-memory cache still works.
    }
  }, 1000);
}

/** Requests index.html started before this bundle loaded, by path. Each is adopted once. */
declare global {
  interface Window {
    __boot?: Record<string, Promise<Response> | undefined>;
  }
}

/** A boot request older than this (the page sat on sign-in, say) is too old to adopt. */
const BOOT_TTL_MS = 30_000;

function adoptBoot<T>(path: string): Promise<T> | null {
  const boot = window.__boot?.[path];
  if (!boot || performance.now() > BOOT_TTL_MS) return null;
  delete window.__boot![path];
  return boot.then((res) => parse<T>(res));
}

/** The last good response for `path`, if any. */
export function peek<T>(path: string): { data: T; at: number; restored: boolean } | null {
  const e = entries.get(path);
  return e && e.data !== undefined ? { data: e.data as T, at: e.at, restored: e.restored === true } : null;
}

/**
 * A "something changed" request (negative `maxAgeMs`) still shares a request in flight that was
 * sent this recently. One SSE nudge wakes several views at once - the Live tab reloads its feed
 * and the alert notifier checks the same path - and each wanting its own request meant two
 * identical GETs for one event. A request this young started after whatever prompted the nudge,
 * or so close to it that the server's own few seconds of caching make no difference between them.
 */
const NUDGE_SHARE_MS = 250;

/**
 * GETs `path`. With `maxAgeMs` >= 0 it shares a request already in flight, and with `maxAgeMs` > 0
 * a cached response from this visit younger than that is returned without a request. A negative `maxAgeMs`
 * sends a new request (for "something changed since that request started") unless one was sent
 * within the last NUDGE_SHARE_MS, which it joins.
 */
export function cachedGet<T>(path: string, maxAgeMs = 0): Promise<T> {
  const e = entries.get(path) ?? { at: 0 };
  entries.set(path, e);
  if (e.inflight && (maxAgeMs >= 0 || Date.now() - (e.inflightAt ?? 0) < NUDGE_SHARE_MS))
    return e.inflight as Promise<T>;
  // An answer kept from an earlier visit is never fresh enough: it is only for painting early.
  if (maxAgeMs > 0 && e.data !== undefined && !e.restored && Date.now() - e.at < maxAgeMs)
    return Promise.resolve(e.data as T);
  const n = ++requests;
  const p = ((maxAgeMs >= 0 && adoptBoot<T>(path)) || api<T>(path)).then((data) => {
    if (n > (e.n ?? 0)) {
      e.data = data;
      e.at = Date.now();
      e.n = n;
      e.restored = false;
      if (persisted(path)) persistSoon();
    }
    return data;
  });
  e.inflight = p;
  e.inflightAt = Date.now();
  const clear = () => {
    if (e.inflight === p) e.inflight = undefined;
  };
  p.then(clear, clear);
  return p;
}

/**
 * Starts a GET now so a component mounting later finds it in flight or done. Does nothing when
 * `path` already has an answer from this visit (of any age) or a request in flight. Never throws.
 */
export function prefetch(path: string): void {
  cachedGet(path, peek(path)?.restored ? 0 : Number.POSITIVE_INFINITY).catch(() => undefined);
}

/** Drops cached responses (all, or those whose path starts with `prefix`), e.g. on sign-out. */
export function invalidate(prefix = ""): void {
  if (window.__boot)
    for (const key of Object.keys(window.__boot)) if (key.startsWith(prefix)) delete window.__boot[key];
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
  if (prefix === "") {
    // Sign-out or a new session: nothing from this wallet stays on the device.
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      // Blocked storage held nothing.
    }
  } else persistSoon();
}
