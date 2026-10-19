import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SenderDownNote } from "./TradePanel";

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
