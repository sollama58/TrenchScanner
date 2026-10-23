import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const put = vi.fn(async () => ({}));
vi.mock("./api", () => ({ put }));
let guest = false;
vi.mock("./session", () => ({ isGuest: () => guest }));

const { syncedSection } = await import("./syncedPrefs");
const { parseLayoutPrefs, DEFAULT_LAYOUT_PREFS } = await import("./layoutPrefs");

type P = { n: number };
const make = (key: string) =>
  syncedSection<P>({
    section: "test",
    storageKey: key,
    defaults: { n: 0 },
    parse: (raw) => ({ n: typeof (raw as P | null)?.n === "number" ? (raw as P).n : 0 }),
  });

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.useFakeTimers();
  put.mockClear();
  guest = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("syncedSection", () => {
  it("keeps changes on this device until the account's settings load, then saves them", async () => {
    const s = make("a");
    s.set({ n: 3 });
    await vi.runAllTimersAsync();
    expect(put).not.toHaveBeenCalled();
    expect(s.synced()).toBe(false);
    // Changed before the load went out: this device's change still wins and is saved.
    s.adopt({ n: 9 }, s.version());
    await vi.runAllTimersAsync();
    expect(s.get()).toEqual({ n: 3 });
    expect(put).toHaveBeenCalledWith("/settings/prefs/test", { n: 3 });
  });

  it("takes the account's copy when nothing changed here, and saves later changes", async () => {
    const s = make("b");
    s.adopt({ n: 7 }, s.version());
    expect(s.get()).toEqual({ n: 7 });
    expect(localStorage.getItem("b")).toBe(JSON.stringify({ n: 7 }));
    s.set({ n: 8 });
    await vi.runAllTimersAsync();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("hands this browser's choice to an account with none saved", async () => {
    const s = make("c");
    guest = true;
    s.set({ n: 2 });
    guest = false;
    s.adopt(null, s.version());
    await vi.runAllTimersAsync();
    expect(put).toHaveBeenCalledWith("/settings/prefs/test", { n: 2 });
  });

  it("never sends a guest's changes, and an account with its own copy replaces them", async () => {
    guest = true;
    const s = make("d");
    s.set({ n: 5 });
    await vi.runAllTimersAsync();
    expect(put).not.toHaveBeenCalled();
    guest = false;
    s.adopt({ n: 1 }, s.version());
    expect(s.get()).toEqual({ n: 1 });
  });

  it("forgets this device's copy on sign-out and stops saving", async () => {
    const s = make("e");
    s.adopt({ n: 4 }, s.version());
    s.reset();
    expect(s.get()).toEqual({ n: 0 });
    expect(localStorage.getItem("e")).toBeNull();
    s.set({ n: 6 });
    await vi.runAllTimersAsync();
    expect(put).not.toHaveBeenCalled();
  });

  it("ignores an API build that sends no prefs", async () => {
    const s = make("f");
    s.adopt(undefined, s.version());
    expect(s.synced()).toBe(false);
  });
});

describe("parseLayoutPrefs", () => {
  it("fills anything missing or unknown with the defaults", () => {
    expect(parseLayoutPrefs(null)).toEqual(DEFAULT_LAYOUT_PREFS);
    expect(parseLayoutPrefs({ liveView: "scope", tokenSide: "nowhere" })).toEqual({
      liveView: "scope",
      tokenSide: "map",
    });
    expect(parseLayoutPrefs({ liveView: "list", tokenSide: "none" })).toEqual({
      liveView: "cards",
      tokenSide: "none",
    });
  });
});
