import type { BuddyAnswer, OverlayBubbleMap, OverlaySafety, OverlaySettings, OverlayToken } from "./types";

/**
 * The only host the extension talks to (the manifest CSP's connect-src). There is no host
 * permission: the API answers /ext/v1 with CORS for extension origins (apps/api/src/server.ts),
 * so these are ordinary cross-origin requests and the install asks for no site access.
 */
export const API_BASE = "https://api.trenchscanner.app";

/** The extension's display choices as kept with the account: when they were saved, and them. */
export interface SavedLook {
  savedAt: number;
  prefs: unknown;
}

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
    call<{
      wallet: string;
      settings: OverlaySettings;
      /** The display choices saved with the account (sw.ts syncLook); absent before 0.7.1's API. */
      look?: SavedLook | null;
      aiReviews?: boolean;
      pro?: boolean;
    }>(key, "GET", "/me"),
  saveLook: (key: string, look: SavedLook) => call<{ ok: boolean }>(key, "PUT", "/look", look),
  saveSettings: (key: string, settings: OverlaySettings) =>
    call<OverlaySettings>(key, "PUT", "/settings", settings),
  feed: (key: string) => call<{ tokens: OverlayToken[] }>(key, "GET", "/feed"),
  bubble: (key: string, mint: string) =>
    call<{ map: OverlayBubbleMap | null }>(key, "GET", `/bubble/${encodeURIComponent(mint)}`),
  /** One read of the site's bubble map, replayed by the API as the key's owner (map/siteMap.ts). */
  site: (key: string, read: { method: string; path: string; body: string | null }, signal?: AbortSignal) =>
    call<{ status: number; body: string }>(
      key,
      "POST",
      "/site",
      read,
      signal
        ? AbortSignal.any([AbortSignal.timeout(SITE_TIMEOUT_MS), signal])
        : AbortSignal.timeout(SITE_TIMEOUT_MS),
    ),
  /** The safety verdicts of up to 100 coins on a board. */
  safety: (key: string, mints: string[]) =>
    call<{ verdicts: Record<string, OverlaySafety> }>(key, "POST", "/safety", { mints }),
  /** One coin's card for the panel's lookup: null when the scanner never stored it. */
  token: (key: string, mint: string) =>
    call<{ token: OverlayToken | null }>(key, "GET", `/token/${encodeURIComponent(mint)}`),
  /** The stats of up to 100 coins on a board (no calls, matches or AI review). */
  stats: (key: string, mints: string[]) =>
    call<{ tokens: Record<string, Omit<OverlayToken, "modelCalls" | "filterMatches" | "ai">> }>(
      key,
      "POST",
      "/stats",
      { mints },
    ),
  /** Trade Buddy, with the reader's other wallets followed too (up to three). */
  buddy: (key: string, wallets: readonly string[] = []) =>
    call<BuddyAnswer>(
      key,
      "GET",
      wallets.length ? `/buddy?wallets=${wallets.map(encodeURIComponent).join(",")}` : "/buddy",
    ),
  /**
   * Held until one of the coins gets a new snapshot (25 s at most), then their new numbers
   * (live board pills); `pushed: false` when the API couldn't hold the ask.
   */
  statsWait: (key: string, mints: string[]) =>
    call<{
      tokens: Record<string, Omit<OverlayToken, "modelCalls" | "filterMatches" | "ai">>;
      pushed: boolean;
    }>(key, "POST", "/stats/wait", { mints }, AbortSignal.timeout(40_000)),
};
