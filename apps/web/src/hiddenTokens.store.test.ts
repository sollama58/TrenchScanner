import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The store's account sync (audit 2026-10-23, AS-1): a save the account refused (a 413 past the
 * body limit) must not let the next load adopt the account's older copy over this device's list.
 */

const put = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<object>()), put }));

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const entry = (tokenId: string) => ({
  tokenId,
  mintAddress: `${tokenId}mint`,
  symbol: tokenId.toUpperCase(),
  name: tokenId,
  imageUrl: null,
  hiddenAt: "2026-10-23T00:00:00.000Z",
  baseMcapUsd: null,
  reachedX: 0,
  graduated: false,
});

describe("hidden tokens account sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", memoryStorage());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    put.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps this device's list over the account's after a failed save, and sends it again", async () => {
    const store = await import("./hiddenTokens");
    const stale = { autoUnhide: true, tokens: [entry("a")] };
    store.adoptHiddenTokens(stale, store.hiddenTokensVersion());
    put.mockRejectedValueOnce(new Error("HTTP 413"));
    store.unhideAll();
    await vi.runAllTimersAsync();
    expect(put).toHaveBeenCalledTimes(1);

    // A reload: a fresh module over the same storage, and the settings load's stale copy.
    vi.resetModules();
    const reloaded = await import("./hiddenTokens");
    put.mockResolvedValueOnce({});
    reloaded.adoptHiddenTokens(stale, reloaded.hiddenTokensVersion());
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![1]).toMatchObject({ tokens: [] });
    await vi.runAllTimersAsync();

    // Saved now: the account's copy is adopted again.
    vi.resetModules();
    const later = await import("./hiddenTokens");
    later.adoptHiddenTokens(stale, later.hiddenTokensVersion());
    expect(put).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem("ts-hidden-tokens")!).tokens).toHaveLength(1);
  });
});
