import { api, parse } from "./api";

/**
 * A small in-memory cache for the dashboard's GET calls, keyed by path.
 *
 * It does three things for load speed: requests started at boot (before React has rendered, see
 * `prefetch` in main.tsx) are picked up by the components that need them instead of being sent
 * again; two views asking for the same path at once share one request; and a tab you come back to
 * paints its last data at once while it refreshes in the background.
 */
interface Entry {
  data?: unknown;
  /** When `data` arrived (ms). */
  at: number;
  inflight?: Promise<unknown>;
  /** Request number of `data`, so an older request landing late can't overwrite a newer answer. */
  n?: number;
}

let requests = 0;

const entries = new Map<string, Entry>();

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
export function peek<T>(path: string): { data: T; at: number } | null {
  const e = entries.get(path);
  return e && e.data !== undefined ? { data: e.data as T, at: e.at } : null;
}

/**
 * GETs `path`. With `maxAgeMs` >= 0 it shares a request already in flight, and with `maxAgeMs` > 0
 * a cached response younger than that is returned without a request. A negative `maxAgeMs` always
 * sends a new request (for "something changed since that request started").
 */
export function cachedGet<T>(path: string, maxAgeMs = 0): Promise<T> {
  const e = entries.get(path) ?? { at: 0 };
  entries.set(path, e);
  if (e.inflight && maxAgeMs >= 0) return e.inflight as Promise<T>;
  if (maxAgeMs > 0 && e.data !== undefined && Date.now() - e.at < maxAgeMs)
    return Promise.resolve(e.data as T);
  const n = ++requests;
  const p = ((maxAgeMs >= 0 && adoptBoot<T>(path)) || api<T>(path)).then((data) => {
    if (n > (e.n ?? 0)) {
      e.data = data;
      e.at = Date.now();
      e.n = n;
    }
    return data;
  });
  e.inflight = p;
  const clear = () => {
    if (e.inflight === p) e.inflight = undefined;
  };
  p.then(clear, clear);
  return p;
}

/** Starts a GET now so a component mounting later finds it in flight or done. Never throws. */
export function prefetch(path: string): void {
  cachedGet(path, 10_000).catch(() => undefined);
}

/** Drops cached responses (all, or those whose path starts with `prefix`), e.g. on sign-out. */
export function invalidate(prefix = ""): void {
  if (window.__boot)
    for (const key of Object.keys(window.__boot)) if (key.startsWith(prefix)) delete window.__boot[key];
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
}
