import type { OverlayLookup, OverlaySettings } from "./types";

/** The only host the extension talks to (manifest host_permissions). */
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
  me: (key: string) => call<{ wallet: string; settings: OverlaySettings }>(key, "GET", "/me"),
  saveSettings: (key: string, settings: OverlaySettings) =>
    call<OverlaySettings>(key, "PUT", "/settings", settings),
  lookup: (key: string, mints: string[]) => call<OverlayLookup>(key, "POST", "/lookup", { mints }),
};
