import { describe, expect, it } from "vitest";
import { RELOAD_GRACE_MS, fetchDeployedVersion, shouldOffer, shouldReloadForChunk } from "./version";

const json = (body: unknown, ok = true) =>
  (async () => ({ ok, json: async () => body }) as Response) as unknown as typeof fetch;

describe("fetchDeployedVersion", () => {
  it("reads the version and asks past every cache", async () => {
    let asked: [string, RequestInit | undefined] | null = null;
    const impl = (async (url: string, init?: RequestInit) => {
      asked = [url, init];
      return { ok: true, json: async () => ({ version: "abc" }) } as Response;
    }) as unknown as typeof fetch;
    expect(await fetchDeployedVersion(impl)).toBe("abc");
    expect(asked![0]).toMatch(/^\/version\.json\?t=\d+$/);
    expect(asked![1]?.cache).toBe("no-store");
  });

  it("is null on a host error, a missing or empty version, bad JSON or no network", async () => {
    expect(await fetchDeployedVersion(json({ version: "abc" }, false))).toBeNull();
    expect(await fetchDeployedVersion(json({}))).toBeNull();
    expect(await fetchDeployedVersion(json({ version: "" }))).toBeNull();
    expect(await fetchDeployedVersion(json({ version: 3 }))).toBeNull();
    const badJson = (async () => ({
      ok: true,
      json: async () => JSON.parse("<html>"),
    })) as unknown as typeof fetch;
    expect(await fetchDeployedVersion(badJson)).toBeNull();
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await fetchDeployedVersion(offline)).toBeNull();
  });
});

describe("shouldOffer", () => {
  const now = 1_000_000_000;
  it("offers a different deployed version", () => {
    expect(shouldOffer("a", "b", null, now)).toBe(true);
  });
  it("stays quiet on the same version, an unknown one, or in dev", () => {
    expect(shouldOffer("a", "a", null, now)).toBe(false);
    expect(shouldOffer("a", null, null, now)).toBe(false);
    expect(shouldOffer("", "b", null, now)).toBe(false);
  });
  it("waits out the grace after reloading for that version and still getting the old page", () => {
    const mark = { version: "b", at: now - 10_000 };
    expect(shouldOffer("a", "b", mark, now)).toBe(false);
    expect(shouldOffer("a", "b", mark, now + RELOAD_GRACE_MS)).toBe(true);
    // A newer deploy than the one reloaded for is offered at once.
    expect(shouldOffer("a", "c", mark, now)).toBe(true);
  });
});

describe("shouldReloadForChunk", () => {
  const now = 1_000_000_000;
  it("reloads once, then lets the error through until the grace has passed", () => {
    expect(shouldReloadForChunk(null, now)).toBe(true);
    expect(shouldReloadForChunk({ version: "chunk", at: now - 5_000 }, now)).toBe(false);
    expect(shouldReloadForChunk({ version: "chunk", at: now - RELOAD_GRACE_MS }, now)).toBe(true);
  });
});
