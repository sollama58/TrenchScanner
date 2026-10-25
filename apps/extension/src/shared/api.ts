import type { BuddyAnswer, OverlayBubbleMap, OverlaySettings, OverlayToken } from "./types";

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

/** A held wait answers within 20 s; past this it is given up and asked again. */
const WAIT_TIMEOUT_MS = 30_000;

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
  /** Held until the coin's next holder reading is written, or 20 s (shared/follow.ts). */
  bubbleWait: (key: string, mint: string) =>
    call<{ changed: boolean; pushed: boolean }>(
      key,
      "GET",
      `/bubble/${encodeURIComponent(mint)}/wait`,
      undefined,
      AbortSignal.timeout(WAIT_TIMEOUT_MS),
    ),
  buddy: (key: string) => call<BuddyAnswer>(key, "GET", "/buddy"),
};
