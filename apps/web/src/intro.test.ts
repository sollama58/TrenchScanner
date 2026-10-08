import { afterEach, describe, expect, it, vi } from "vitest";
import { introKey, introSeen, markIntroSeen } from "./intro";

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("intro tour, seen once", () => {
  it("is remembered per wallet, and once for guests", () => {
    stubStorage();
    expect(introSeen("WalletA")).toBe(false);
    markIntroSeen("WalletA");
    expect(introSeen("WalletA")).toBe(true);
    expect(introSeen("WalletB")).toBe(false);
    expect(introSeen(null)).toBe(false);
    markIntroSeen(null);
    expect(introSeen(null)).toBe(true);
    expect(introKey(null)).toBe("ts-intro-seen:guest");
  });

  it("doesn't pop up on every visit when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(introSeen("WalletA")).toBe(true);
    expect(() => markIntroSeen("WalletA")).not.toThrow();
  });
});
