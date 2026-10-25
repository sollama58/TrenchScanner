import type { BuddyAnswer, OverlayBubbleMap, OverlaySafety, OverlaySettings, OverlayToken } from "./types";

/**
 * The only host the extension talks to (the manifest CSP's connect-src). There is no host
 * permission: the API answers /ext/v1 with CORS for extension origins (apps/api/src/server.ts),
 * so these are ordinary cross-origin requests and the install asks for no site access.
 */
export const API_BASE = "https://api.trenchscanner.app";

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`api ${status}`);
  }
}

/** The site map's held reads (its holder wait, its live trades) answer within 30 s; past this, given up. */
const SITE_TIMEOUT_MS = 45_000;

async function call<T>(
  key: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${API_BASE}/ext/v1${path}`, {
    signal,
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
  });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

export const api = {
  me: (key: string) =>
    call<{ wallet: string; settings: OverlaySettings; aiReviews?: boolean; pro?: boolean }>(
      key,
      "GET",
      "/me",
    ),
  saveSettings: (key: string, settings: OverlaySettings) =>
    call<OverlaySettings>(key, "PUT", "/settings", settings),
  feed: (key: string) => call<{ tokens: OverlayToken[] }>(key, "GET", "/feed"),
  bubble: (key: string, mint: string) =>
    call<{ map: OverlayBubbleMap | null }>(key, "GET", `/bubble/${encodeURIComponent(mint)}`),
  /** One read of the site's bubble map, replayed by the API as the key's owner (map/siteMap.ts). */
  site: (key: string, read: { method: string; path: string; body: string | null }) =>
    call<{ status: number; body: string }>(key, "POST", "/site", read, AbortSignal.timeout(SITE_TIMEOUT_MS)),
  /** The safety verdicts of up to 100 coins on a board. */
  safety: (key: string, mints: string[]) =>
    call<{ verdicts: Record<string, OverlaySafety> }>(key, "POST", "/safety", { mints }),
  buddy: (key: string) => call<BuddyAnswer>(key, "GET", "/buddy"),
};
