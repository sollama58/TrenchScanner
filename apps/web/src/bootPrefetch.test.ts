import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
const boot = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1] ?? "")
  .find((s) => s.includes("window.__boot"))!;

/** Runs index.html's boot prefetch with this localStorage and returns the paths it fetched. */
function bootPaths(stored: Record<string, string>, hash = ""): string[] {
  const fetched: string[] = [];
  const window: Record<string, unknown> = {};
  window.fetch = (url: string) => {
    fetched.push(url.replace("https://api.trenchscanner.app", ""));
    return Promise.resolve();
  };
  runInNewContext(boot, {
    window,
    fetch: window.fetch,
    location: { hostname: "trenchscanner.app", hash },
    localStorage: { getItem: (k: string) => stored[k] ?? null },
    Intl,
  });
  return fetched;
}

describe("index.html boot prefetch", () => {
  it("asks only /auth/me of the account reads on a first visit (audit 10-27 WB-33)", () => {
    const paths = bootPaths({});
    expect(paths).toContain("/auth/me");
    expect(paths).toContain("/guest/best");
    // Each of these came back 401 on every signed-out load.
    for (const p of [
      "/subscription",
      "/settings",
      "/matches/stats?hours=24",
      "/curated/stats",
      "/curated/models?days=30",
    ])
      expect(paths).not.toContain(p);
    expect(paths.some((p) => p.startsWith("/matches?"))).toBe(false);
  });

  it("still starts the Live tab's reads for a returning session", () => {
    const paths = bootPaths({ "ts-session-token": "t" });
    expect(paths).toEqual(
      expect.arrayContaining([
        "/auth/me",
        "/subscription",
        "/settings",
        "/curated/models?days=30",
        "/curated/stats",
      ]),
    );
    expect(paths).not.toContain("/guest/best");
  });

  it("starts only the public guest reads for a guest", () => {
    const paths = bootPaths({ "ts-guest": "1" });
    expect(paths).toEqual(["/health/worker", "/announcement", "/guest/feed?page=1"]);
  });
});
