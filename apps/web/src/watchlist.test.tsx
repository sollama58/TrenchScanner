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
    put: (path: string, body?: unknown) => run("PUT", path, body),
  };
});
vi.mock("./session", () => ({ isGuest: () => false }));

const { ApiError } = await import("./api");
const store = await import("./watchlist");
const { WatchlistPanel } = await import("./components/WatchlistPanel");
const { WatchStar } = await import("./components/WatchStar");
const { rowsThatFit } = await import("./components/WatchlistPanel");
const { WatchlistChips } = await import("./components/WatchlistChips");
const { WatchlistManager } = await import("./components/WatchlistManager");

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
    expect(html).toMatch(/watchlist-count[^>]*>2\/50</);
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

describe("the cap", () => {
  it("refuses an eleventh star and says why on the star", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => item(`t${i}`));
    answer = () => ({ cap: 10, items: ten });
    await store.loadWatchlist();
    const html = renderToStaticMarkup(<WatchStar token={token("new")} />);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('title="Watchlist is full (10)"');
    // A watched token's star still unstars it.
    expect(renderToStaticMarkup(<WatchStar token={token("t1")} />)).not.toContain("aria-disabled");
    calls.length = 0;
    await store.watchToken(token("new"));
    expect(calls).toEqual([]);
    expect(state().notice).toMatch(/Watchlist is full \(10\)/);
    expect(renderToStaticMarkup(<WatchlistPanel />)).toMatch(/watchlist-count num full[^>]*>10\/10</);
  });
});

describe("order, clear and add by address", () => {
  it("reorders at once and keeps the server's answer", async () => {
    answer = () => ({ cap: 10, items: [item("a"), item("b"), item("c")] });
    await store.loadWatchlist();
    answer = (method, _path, body) =>
      method === "PUT"
        ? { cap: 10, items: (body as { tokenIds: string[] }).tokenIds.map((id) => item(id)) }
        : null;
    store.moveWatched("c", -1);
    expect(state().items.map((i) => i.tokenId)).toEqual(["a", "c", "b"]);
    await Promise.resolve();
    expect(calls.at(-1)).toEqual({
      method: "PUT",
      path: "/watchlist/order",
      body: { tokenIds: ["a", "c", "b"] },
    });
  });

  it("puts the order back when its save fails", async () => {
    answer = () => ({ cap: 10, items: [item("a"), item("b")] });
    await store.loadWatchlist();
    answer = () => new Error("offline");
    await store.reorderWatchlist(["b", "a"]);
    expect(state().items.map((i) => i.tokenId)).toEqual(["a", "b"]);
  });

  it("clears the list", async () => {
    answer = () => ({ cap: 10, items: [item("a"), item("b")] });
    await store.loadWatchlist();
    answer = () => ({ removed: 2 });
    await store.clearWatchlist();
    expect(state().items).toEqual([]);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/watchlist" });
  });

  it("adds by contract address, or says why not", async () => {
    await store.loadWatchlist();
    answer = (method) => (method === "POST" ? { item: item("m") } : null);
    expect(await store.watchMint("mMint1111111111111111111111111111111")).toBeNull();
    expect(state().items[0]?.tokenId).toBe("m");
    answer = () => new ApiError(404, "TrenchScanner doesn't track this token yet.", null);
    expect(await store.watchMint("Other111111111111111111111111111111")).toMatch(/doesn't track/);
  });
});

describe("fitting", () => {
  it("shows the rows that fit whole, keeping room for +N", () => {
    expect(rowsThatFit(3, null)).toBe(3);
    // 3 rows (99px) and the button (28px) fit in 130px.
    expect(rowsThatFit(3, 130)).toBe(3);
    expect(rowsThatFit(10, 160)).toBe(4);
    expect(rowsThatFit(10, 20)).toBe(1);
  });

  it("renders chips with ticker, market cap and 24h change", async () => {
    answer = () => ({ cap: 10, items: [item("pepe", { priceChange24hPct: 33 })] });
    await store.loadWatchlist();
    const html = renderToStaticMarkup(<WatchlistChips onMore={() => undefined} />);
    expect(html).toContain('class="mkt-mini-chip wl-chip"');
    expect(html).toContain("$PEPE");
    expect(html).toContain("$50.0K");
    expect(html).toContain('class="num wl-chip-chg up"');
    expect(html).toContain('aria-label="Open your watchlist"');
  });

  it("counts the chips left out by max on its +N", async () => {
    answer = () => ({ cap: 10, items: [item("a"), item("b"), item("c")] });
    await store.loadWatchlist();
    const html = renderToStaticMarkup(<WatchlistChips max={1} onMore={() => undefined} />);
    expect(html).toContain("$A");
    expect(html).not.toContain("$B");
    expect(html).toContain('aria-label="2 more watched tokens"');
  });

  it("renders the manager's rows and meter", async () => {
    answer = () => ({ cap: 10, items: [item("pepe"), item("dog")] });
    await store.loadWatchlist();
    const html = renderToStaticMarkup(<WatchlistManager />);
    expect(html).toContain('aria-label="Move $PEPE up"');
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain("Clear all");
  });
});
