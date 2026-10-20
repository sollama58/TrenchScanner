import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { quoteText, SenderDownNote } from "./TradePanel";
import { sellSizing, STALE_TOTAL_SALE } from "../proTrade";

describe("quoteText", () => {
  const built = {
    quotedOut: "1500000",
    minOut: "1000000",
    priorityFeeLamports: "5000",
    tipLamports: "5000",
  };
  it("uses the build's decimals and its rent, and says nothing until decimals are known", () => {
    expect(quoteText(built, "buy", null, "PEPE", null)).toBeNull();
    expect(quoteText({ ...built, decimals: null }, "buy", { decimals: 6 }, "PEPE", null)).toBeNull();
    const at6 = quoteText({ ...built, decimals: 6 }, "buy", { decimals: 9 }, "PEPE", "2039280");
    const at9 = quoteText(built, "buy", { decimals: 9 }, "PEPE", null);
    expect(at6).toMatch(/^About 1\.50 PEPE, at least 1\.00;/);
    expect(at6).toMatch(/token account rent/);
    expect(at9).not.toMatch(/1\.5 PEPE/);
    expect(at9).not.toMatch(/token account rent/);
    expect(quoteText(built, "sell", null, "PEPE", "2039280")).toMatch(/^About /);
  });
});

describe("sell sizing", () => {
  it("sizes a sale from the associated account, and caps sell all at the transfer fee", () => {
    const sized = sellSizing({
      balance: "150",
      tradable: "100",
      elsewhere: "50",
      transferFeeBps: 1000,
      sellable: "90",
    });
    expect(sized).toEqual({ ata: 100n, elsewhere: 50n, sellable: 90n, feeBps: 1000 });
    expect(STALE_TOTAL_SALE).toMatch(/whole balance wasn't sent/);
  });
});

describe("the Trade panel's Sender-down notice", () => {
  it("warns that shielded trades may expire while the MEV shield is on", () => {
    const html = renderToStaticMarkup(<SenderDownNote mevProtect />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Helius Sender is down.");
    expect(html).toContain("Trades with the MEV shield off still go through");
    expect(html).toContain("shielded trades may expire until it&#x27;s back");
  });

  it("only notes it, quietly, while the shield is off", () => {
    const html = renderToStaticMarkup(<SenderDownNote mevProtect={false} />);
    expect(html).toContain('role="note"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Helius Sender is down. Your trades still go through");
  });
});
