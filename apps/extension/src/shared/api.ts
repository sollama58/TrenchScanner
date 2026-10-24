import type { OverlaySettings, OverlayToken } from "./types";

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

async function call<T>(
  key: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE}/ext/v1${path}`, {
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
    call<{ wallet: string; settings: OverlaySettings; aiReviews?: boolean }>(key, "GET", "/me"),
  saveSettings: (key: string, settings: OverlaySettings) =>
    call<OverlaySettings>(key, "PUT", "/settings", settings),
  feed: (key: string) => call<{ tokens: OverlayToken[] }>(key, "GET", "/feed"),
};
