import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privyOAuthReturn, rememberPlace, restorePlace } from "./privyBridge";

describe("privyOAuthReturn", () => {
  it("spots Privy's Google or X return in the address, and nothing else", () => {
    expect(privyOAuthReturn("?privy_oauth_code=abc&privy_oauth_state=def&privy_oauth_provider=google")).toBe(
      true,
    );
    expect(privyOAuthReturn("?tab=live&privy_oauth_state=def")).toBe(true);
    expect(privyOAuthReturn("")).toBe(false);
    expect(privyOAuthReturn("?wallet=abc")).toBe(false);
    expect(privyOAuthReturn("?my_privy_oauth_code=abc")).toBe(false);
  });
});

describe("rememberPlace / restorePlace", () => {
  const store = new Map<string, string>();
  const at = { path: "/" };
  beforeEach(() => {
    store.clear();
    at.path = "/?sage=So11111111111111111111111111111111111111112#settings";
    const events: string[] = [];
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal("window", {
      get location() {
        const u = new URL(at.path, "https://trenchscanner.app");
        return { pathname: u.pathname, search: u.search, hash: u.hash };
      },
      history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (at.path = url) },
      dispatchEvent: (e: Event) => void events.push(e.type),
      events,
    });
    vi.stubGlobal("PopStateEvent", class extends Event {});
    vi.stubGlobal("HashChangeEvent", class extends Event {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts from the root and puts the tab and token link back after", () => {
    rememberPlace();
    expect(at.path).toBe("/");
    restorePlace();
    expect(at.path).toBe("/?sage=So11111111111111111111111111111111111111112#settings");
    expect((window as unknown as { events: string[] }).events).toEqual(["popstate", "hashchange"]);
    // Once only.
    at.path = "/";
    restorePlace();
    expect(at.path).toBe("/");
  });

  it("leaves nothing older to put back when it starts at the root", () => {
    store.set("ts:privy-place", "/#old");
    at.path = "/";
    rememberPlace();
    restorePlace();
    expect(at.path).toBe("/");
  });

  it("never puts back an address off this site", () => {
    store.set("ts:privy-place", "//evil.example/x");
    at.path = "/";
    restorePlace();
    expect(at.path).toBe("/");
  });
});
