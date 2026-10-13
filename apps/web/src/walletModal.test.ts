import { describe, expect, it } from "vitest";
import { WALLET_LINKS, walletFromUrl, walletLink } from "./walletModal";

const W = "Wa11et1111111111111111111111111111111111111";

describe("wallet modal URL", () => {
  it("reads a wallet from the address bar and ignores anything else", () => {
    expect(walletFromUrl(`?wallet=${W}`)).toBe(W);
    expect(walletFromUrl("?wallet=not-an-address")).toBeNull();
    expect(walletFromUrl("?bubbles=abc")).toBeNull();
  });

  it("links to the page with only the wallet", () => {
    expect(walletLink(W, "https://trenchscanner.app/?bubbles=x#model")).toBe(
      `https://trenchscanner.app/?wallet=${W}`,
    );
  });

  it("puts the wallet in every outside link", () => {
    for (const l of WALLET_LINKS) expect(l.href(W)).toContain(W);
  });
});
