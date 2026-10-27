// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { token } from "../shared/testToken";
import type { BuddyCoin } from "../shared/types";
import { buddyCard, shortWallet, summaryBlock, tradeUrl } from "./buddy";

const A = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";

describe("Trade Buddy cards", () => {
  const coin: BuddyCoin = {
    mint: A,
    entryAt: new Date(Date.now() - 600_000).toISOString(),
    lastTradeAt: new Date(Date.now() - 600_000).toISOString(),
    buys: 1,
    sells: 0,
    spentSol: 0.5,
    gotSol: 0,
    held: 1_200_000,
    chainHeld: 1_200_000,
    closed: false,
    mismatch: false,
    entryMcapUsd: 10_000,
    nowMcapUsd: 15_000,
    pnlSol: 0.25,
    pnlPct: 50,
    priceAt: new Date().toISOString(),
    priceSource: "market",
    token: token(),
    symbol: "RING",
    name: "Ring Coin",
    image: null,
  };

  it("shows the PnL and the move since the buy, and the trade box only for Pro, collapsed", () => {
    const card = buddyCard(coin, DEFAULT_SETTINGS, false);
    expect(card.textContent).toContain("+0.250 SOL (+50%)");
    expect(card.textContent).toContain("Bought at $10.0K");
    expect(card.textContent).toContain("now $15.0K (+50%)");
    expect(card.textContent).toContain("Holding 1.2M");
    expect(card.querySelector("details.trade")).toBeNull();

    const pro = buddyCard(coin, DEFAULT_SETTINGS, true);
    const box = pro.querySelector("details.trade") as HTMLDetailsElement;
    expect(box.open).toBe(false);
    const hrefs = [...box.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(`https://trenchscanner.app/?trade=${A}&buy=0.5`);
    expect(hrefs).toContain(`https://trenchscanner.app/?trade=${A}&sell=100`);
  });

  it("says when the wallet doesn't match its trades, and offers no sale of a sold-out coin", () => {
    const card = buddyCard({ ...coin, mismatch: true, pnlSol: null, pnlPct: null }, DEFAULT_SETTINGS, false);
    expect(card.textContent).toContain("Can't tell");
    const sold = buddyCard({ ...coin, closed: true, held: 0, chainHeld: 0 }, DEFAULT_SETTINGS, true);
    expect(sold.querySelector("a.preset.sell")).toBeNull();
    expect(tradeUrl("not-a-mint", "buy", 1)).toBeNull();
  });
});

describe("Trade Buddy's summary", () => {
  it("shows the day's result, sold and held apart, and dashes what isn't known", () => {
    const box = summaryBlock({
      hours: 24,
      trades: 9,
      buys: 6,
      sells: 3,
      coins: 4,
      volumeSol: 3.2,
      closed: 2,
      open: 2,
      winRatePct: 50,
      realizedSol: 0.4,
      unrealizedSol: -0.1,
      bestMultiple: 2.4,
      calledFirst: 1,
      entries: 4,
    });
    const cells = [...box.querySelectorAll(".stat")];
    expect(cells[0]?.className).toBe("stat up");
    expect(cells[2]?.className).toBe("stat down");
    expect(cells[3]?.textContent).toBe("50%won, of 2 closed");
    expect(cells[4]?.textContent).toBe("2.4xbest trade");
    expect(shortWallet(A)).toBe("6p6x…GiPN");
  });
});
