import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureReturnTo, hasReturnTo, safeReturnUrl, signInUrl, takeReturnTo } from "./returnTo";

describe("safeReturnUrl", () => {
  it("follows the dashboard's own sites over https", () => {
    expect(safeReturnUrl("https://asyl.trenchscanner.app/w/abc", "https://trenchscanner.app")).toBe(
      "https://asyl.trenchscanner.app/w/abc",
    );
    expect(safeReturnUrl("https://trenchscanner.app/#model", "https://trenchscanner.app")).toBe(
      "https://trenchscanner.app/#model",
    );
  });

  it("refuses anywhere else, and lookalikes", () => {
    const here = "https://trenchscanner.app";
    expect(safeReturnUrl("https://evil.example/", here)).toBeNull();
    expect(safeReturnUrl("https://trenchscanner.app.evil.example/", here)).toBeNull();
    expect(safeReturnUrl("https://eviltrenchscanner.app/", here)).toBeNull();
    expect(safeReturnUrl("http://asyl.trenchscanner.app/", here)).toBeNull();
    expect(safeReturnUrl("javascript:alert(1)", here)).toBeNull();
    expect(safeReturnUrl("https://user:pw@asyl.trenchscanner.app/", here)).toBeNull();
    expect(safeReturnUrl("/relative", here)).toBeNull();
    expect(safeReturnUrl(null, here)).toBeNull();
  });

  it("allows this page's own origin, for local development", () => {
    expect(safeReturnUrl("http://localhost:5173/asyl/", "http://localhost:5173")).toBe(
      "http://localhost:5173/asyl/",
    );
    expect(safeReturnUrl("http://localhost:9999/", "http://localhost:5173")).toBeNull();
  });
});

describe("signInUrl", () => {
  it("points a trenchscanner.app subdomain at the dashboard's sign-in", () => {
    expect(
      signInUrl(
        "https://asyl.trenchscanner.app/w/x",
        "asyl.trenchscanner.app",
        "https://asyl.trenchscanner.app",
      ),
    ).toBe("https://trenchscanner.app/?return=https%3A%2F%2Fasyl.trenchscanner.app%2Fw%2Fx");
  });

  it("stays on this origin elsewhere", () => {
    expect(signInUrl("http://localhost:5173/asyl/", "localhost", "http://localhost:5173")).toBe(
      "http://localhost:5173/?return=http%3A%2F%2Flocalhost%3A5173%2Fasyl%2F",
    );
  });
});

describe("captureReturnTo and takeReturnTo", () => {
  const store = new Map<string, string>();
  const original = {
    location: globalThis.location,
    history: globalThis.history,
    sessionStorage: globalThis.sessionStorage,
  };
  let replaced = "";

  beforeEach(() => {
    store.clear();
    replaced = "";
    Object.assign(globalThis, {
      location: {
        origin: "https://trenchscanner.app",
        pathname: "/",
        search: "",
        hash: "#live",
        hostname: "trenchscanner.app",
      },
      history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => (replaced = url) },
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });
  afterEach(() => {
    Object.assign(globalThis, original);
  });

  it("keeps a safe address once and cleans the address bar", () => {
    (globalThis.location as { search: string }).search =
      `?return=${encodeURIComponent("https://asyl.trenchscanner.app/m/abc")}&sage=x`;
    captureReturnTo();
    expect(replaced).toBe("/?sage=x#live");
    expect(hasReturnTo()).toBe(true);
    expect(takeReturnTo()).toBe("https://asyl.trenchscanner.app/m/abc");
    expect(takeReturnTo()).toBeNull();
  });

  it("drops an unsafe address but still cleans the address bar", () => {
    (globalThis.location as { search: string }).search =
      `?return=${encodeURIComponent("https://evil.example/")}`;
    captureReturnTo();
    expect(replaced).toBe("/#live");
    expect(hasReturnTo()).toBe(false);
  });

  it("does nothing without the parameter", () => {
    captureReturnTo();
    expect(replaced).toBe("");
  });
});
