import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
const boot = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1] ?? "")
  .find((s) => s.includes("window.__boot"))!;

/**
 * Runs index.html's boot prefetch with this localStorage and returns the paths it fetched and the
 * code it preloaded. `chunks` is the build's ts-boot-chunks list (vite.config.ts bootChunks); null
 * runs it with no document at all, as an old browser's failure would.
 */
function runBoot(
  stored: Record<string, string>,
  hash = "",
  chunks: Record<string, string[]> | null = null,
): { fetched: string[]; preloaded: string[] } {
  const fetched: string[] = [];
  const preloaded: string[] = [];
  const window: Record<string, unknown> = {};
  window.fetch = (url: string) => {
    fetched.push(url.replace("https://api.trenchscanner.app", ""));
    return Promise.resolve();
  };
  const document =
    chunks === null
      ? undefined
      : {
          querySelector: (q: string) =>
            q === 'meta[name="ts-boot-chunks"]'
              ? {
                  getAttribute: () =>
                    Object.entries(chunks)
                      .map(([name, files]) => `${name}=${files.join(" ")}`)
                      .join(";"),
                }
              : null,
          createElement: () => ({}) as Record<string, string>,
          head: {
            appendChild: (l: Record<string, string>) => {
              expect(l.rel).toBe("modulepreload");
              expect(l.crossOrigin).toBe("");
              preloaded.push(l.href!);
            },
          },
        };
  runInNewContext(boot, {
    window,
    document,
    fetch: window.fetch,
    location: { hostname: "trenchscanner.app", hash },
    localStorage: { getItem: (k: string) => stored[k] ?? null },
    Intl,
  });
  return { fetched, preloaded };
}

const bootPaths = (stored: Record<string, string>, hash = ""): string[] => runBoot(stored, hash).fetched;

const CHUNKS = { signin: ["/assets/SignIn.js"], model: ["/assets/ModelTab.js", "/assets/Charts.js"] };

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
    expect(paths).toEqual([
      "/health/worker",
      "/announcement",
      "/guest/feed?page=1",
      "/guest/market/prices",
      "/guest/market/trench",
      "/config/score",
      "/config/narrative-note",
    ]);
  });

  it("starts the market bar and the cards' config with the Live tab's feed", () => {
    const paths = bootPaths({ "ts-session-token": "t" });
    expect(paths).toEqual(
      expect.arrayContaining([
        "/curated/market/prices",
        "/curated/market/trench",
        "/config/score",
        "/config/narrative-note",
      ]),
    );
    // Not on a tab that has neither.
    expect(bootPaths({ "ts-session-token": "t" }, "#settings")).not.toContain("/curated/market/prices");
  });

  it("preloads the sign-in code on a first visit, and a linked tab's code", () => {
    expect(runBoot({}, "", CHUNKS).preloaded).toEqual(["/assets/SignIn.js"]);
    expect(runBoot({ "ts-session-token": "t" }, "", CHUNKS).preloaded).toEqual([]);
    expect(runBoot({ "ts-session-token": "t" }, "#model", CHUNKS).preloaded).toEqual([
      "/assets/ModelTab.js",
      "/assets/Charts.js",
    ]);
    // A link opened by a first visit lands on sign-in: both.
    expect(runBoot({}, "#model", CHUNKS).preloaded).toEqual([
      "/assets/ModelTab.js",
      "/assets/Charts.js",
      "/assets/SignIn.js",
    ]);
  });

  it("still starts the reads with no build list or no document", () => {
    expect(runBoot({ "ts-session-token": "t" }, "", {}).fetched).toContain("/auth/me");
    expect(runBoot({ "ts-session-token": "t" }, "#model", null).fetched).toContain("/auth/me");
  });
});
