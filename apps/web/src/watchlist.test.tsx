import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; path: string; body?: unknown }[] = [];
let answer: (method: string, path: string, body?: unknown) => unknown = () => ({ cap: 50, items: [] });

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  const run = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const out = answer(method, path, body);
    if (out instanceof Error) throw out;
    return out;
  };
  return {
    ...actual,
    api: (path: string) => run("GET", path),
    post: (path: string, body?: unknown) => run("POST", path, body),
    del: (path: string) => run("DELETE", path),
  };
});
vi.mock("./session", () => ({ isGuest: () => false }));

const { ApiError } = await import("./api");
const store = await import("./watchlist");
const { WatchlistPanel } = await import("./components/WatchlistPanel");
const { WatchStar } = await import("./components/WatchStar");

const item = (tokenId: string, over: Partial<import("./watchlist").WatchlistItem> = {}) => ({
  tokenId,
  mint: `${tokenId}Mint1111111111111111111111111111111`,
  symbol: tokenId.toUpperCase(),
  name: `${tokenId} coin`,
  imageUrl: null,
  addedAt: new Date(Date.now() - 3_600_000).toISOString(),
  addedMarketCapUsd: 40_000,
  addedPriceUsd: 0.00004,
  marketCapUsd: 50_000,
  priceUsd: 0.00005,
  at: new Date().toISOString(),
  changeSinceAddedPct: 25,
  priceChange1hPct: -4,
  changeAt: new Date().toISOString(),
  ...over,
});

const token = (tokenId: string) => ({
  tokenId,
  mint: `${tokenId}Mint1111111111111111111111111111111`,
  symbol: tokenId.toUpperCase(),
  name: null,
  imageUrl: null,
  marketCapUsd: 12_000,
});

function state() {
  let s: import("./watchlist").WatchlistState | null = null;
  function Probe() {
    s = store.useWatchlist();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return s!;
}

beforeEach(() => {
  calls.length = 0;
  store.resetWatchlist();
});
afterEach(() => {
  answer = () => ({ cap: 50, items: [] });
});

describe("watchlist store", () => {
  it("loads the account's list", async () => {
    answer = () => ({ cap: 50, items: [item("a"), item("b")] });
    await store.loadWatchlist();
    expect(state().status).toBe("ready");
    expect(state().items.map((i) => i.tokenId)).toEqual(["a", "b"]);
  });

  it("turns off for a reader without access", async () => {
    answer = () => new ApiError(402, "subscription_required", { error: "subscription_required" });
    await store.loadWatchlist();
    expect(state().status).toBe("off");
    expect(renderToStaticMarkup(<WatchStar token={token("a")} />)).toBe("");
  });

  it("stars at once and keeps the server's entry", async () => {
    await store.loadWatchlist();
    answer = (method) => (method === "POST" ? { item: item("c", { addedMarketCapUsd: 12_500 }) } : null);
    const saving = store.watchToken(token("c"));
    // Optimistic: watched before the save answers, with the card's figure.
    expect(state().items[0]).toMatchObject({ tokenId: "c", marketCapUsd: 12_000, changeSinceAddedPct: 0 });
    await saving;
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/watchlist", body: { tokenId: "c" } });
    expect(state().items[0]?.addedMarketCapUsd).toBe(12_500);
  });

  it("puts a star back when the save fails, and says so", async () => {
    await store.loadWatchlist();
    answer = () => new ApiError(409, "full", { error: "full" });
    await store.watchToken(token("d"));
    expect(state().items).toEqual([]);
    expect(state().notice).toMatch(/full/);

    answer = () => ({ cap: 50, items: [item("e"), item("f")] });
    await store.loadWatchlist();
    answer = () => new Error("offline");
    await store.unwatchToken("f");
    expect(state().items.map((i) => i.tokenId)).toEqual(["e", "f"]);
  });

  it("keeps a removal made while a poll was on its way", async () => {
    answer = () => ({ cap: 50, items: [item("g")] });
    await store.loadWatchlist();
    let release: (v: unknown) => void = () => {};
    answer = (method) =>
      method === "DELETE" ? new Promise((r) => (release = r)) : { cap: 50, items: [item("g")] };
    const removing = store.unwatchToken("g");
    await store.loadWatchlist();
    expect(state().items).toEqual([]);
    release({ removed: true });
    await removing;
    expect(state().items).toEqual([]);
  });
});

describe("WatchlistPanel", () => {
  it("shows the empty state", async () => {
    await store.loadWatchlist();
    const html = renderToStaticMarkup(<WatchlistPanel />);
    expect(html).toContain("Star a token on any card to watch it here");
  });

  it("lists each token with its market cap and change", async () => {
    answer = () => ({ cap: 50, items: [item("pepe"), item("dog", { changeSinceAddedPct: -12.3 })] });
    await store.loadWatchlist();
    const html = renderToStaticMarkup(<WatchlistPanel />);
    expect(html).toContain("$PEPE");
    expect(html).toContain("$50.0K");
    expect(html).toContain('class="num watchlist-chg up"');
    expect(html).toContain('class="num watchlist-chg down"');
    expect(html).toContain("-12%");
    expect(html).toContain('aria-label="Remove $DOG from your watchlist"');
    expect(html).toMatch(/watchlist-count[^>]*>2</);
  });

  it("marks a watched token's star", async () => {
    answer = () => ({ cap: 50, items: [item("a")] });
    await store.loadWatchlist();
    expect(renderToStaticMarkup(<WatchStar token={token("a")} />)).toContain('aria-pressed="true"');
    expect(renderToStaticMarkup(<WatchStar token={token("z")} />)).toContain(
      'aria-label="Add $Z to your watchlist"',
    );
  });
});
