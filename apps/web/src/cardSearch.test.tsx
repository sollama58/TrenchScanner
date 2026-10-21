import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, normalizeAppearance } from "./appearance";
import { CardSearchButton } from "./components/CardSearchButton";
import { DEFAULT_SCOPE_SETTINGS, normalizeScopeSettings } from "./scopeSettings";
import { cardSearchQuery, googleSearchHref, overlaySearchMarket, xSearchHref } from "./cardSearch";
import type { TokenSearchHit } from "./api";

const MINT = "TokenSearchExact111111111111111111111111111";

const hit = (over: Partial<TokenSearchHit> = {}): TokenSearchHit => ({
  mint: MINT,
  symbol: "PEPE",
  name: "Pepe Coin",
  imageUrl: "https://img.example/pepe.png",
  marketCapUsd: 4_000,
  marketCapAt: "2026-10-21T00:00:00.000Z",
  volume24hUsd: 10,
  liquidityUsd: 20,
  holderCount: 5,
  graduated: false,
  launchedAt: "2026-10-21T00:00:00.000Z",
  yourAlertAt: null,
  modelCalls: 0,
  lastCallAt: null,
  bestCallPeakPct: null,
  quoteMint: null,
  quoteSymbol: null,
  feeDestination: null,
  ...over,
});

describe("card search queries", () => {
  it("prefers a ticker the search can match, otherwise the name", () => {
    expect(cardSearchQuery("PEPE", "Pepe Coin")).toBe("PEPE");
    expect(cardSearchQuery("$PEPE", "Pepe Coin")).toBe("PEPE");
    expect(cardSearchQuery("A", "Pepe Coin")).toBe("Pepe Coin");
    expect(cardSearchQuery(null, "Pepe Coin")).toBe("Pepe Coin");
    expect(cardSearchQuery("A", "B")).toBe("");
  });

  it("builds encoded X and Google links for the name and the contract", () => {
    expect(xSearchHref("PEPE")).toBe("https://x.com/search?q=PEPE&src=typed_query");
    expect(xSearchHref("Pepe Coin")).toBe("https://x.com/search?q=Pepe%20Coin&src=typed_query");
    expect(xSearchHref("A&B")).toBe("https://x.com/search?q=A%26B&src=typed_query");
    expect(xSearchHref(MINT)).toBe(`https://x.com/search?q=${MINT}&src=typed_query`);
    expect(googleSearchHref("Pepe Coin")).toBe("https://www.google.com/search?q=Pepe%20Coin");
  });
});

describe("card search is on unless the look says otherwise", () => {
  it("defaults on for Cards and Scope, and keeps an explicit off", () => {
    expect(DEFAULT_APPEARANCE.cardSearch).toBe(true);
    expect(normalizeAppearance({}).cardSearch).toBe(true);
    expect(normalizeAppearance({ cardSearch: false }).cardSearch).toBe(false);
    expect(DEFAULT_SCOPE_SETTINGS.display.showSearch).toBe(true);
    expect(normalizeScopeSettings({}).display.showSearch).toBe(true);
    expect(normalizeScopeSettings({ display: { showSearch: false } }).display.showSearch).toBe(false);
  });
});

describe("overlaySearchMarket", () => {
  it("takes a newer market cap and keeps a volume the patch does not have", () => {
    const next = overlaySearchMarket(hit(), {
      mint: MINT,
      symbol: "NO",
      name: "No",
      imageUrl: "https://other.example/x.png",
      marketCapUsd: 9_000,
      marketCapAt: "2026-10-21T00:00:30.000Z",
      volume24hUsd: null,
      liquidityUsd: 50,
      holderCount: null,
    });
    expect(next).toMatchObject({
      marketCapUsd: 9_000,
      volume24hUsd: 10,
      liquidityUsd: 50,
      holderCount: 5,
      symbol: "PEPE",
      imageUrl: "https://img.example/pepe.png",
    });
  });

  it("fills a blank from an older patch without moving the market cap backwards", () => {
    const next = overlaySearchMarket(hit({ volume24hUsd: null, imageUrl: null }), {
      mint: MINT,
      symbol: null,
      name: null,
      imageUrl: "https://dex.example/a.png",
      marketCapUsd: 1,
      marketCapAt: "2026-10-20T00:00:00.000Z",
      volume24hUsd: 80,
      liquidityUsd: null,
      holderCount: null,
    });
    expect(next.marketCapUsd).toBe(4_000);
    expect(next.volume24hUsd).toBe(80);
    expect(next.imageUrl).toBe("https://dex.example/a.png");
  });
});

describe("CardSearchButton", () => {
  it("renders a search control for the token", () => {
    const html = renderToStaticMarkup(<CardSearchButton symbol="PEPE" name="Pepe Coin" mint={MINT} />);
    expect(html).toContain('aria-label="Search $PEPE"');
    expect(html).toContain("card-search-btn");
  });
});
