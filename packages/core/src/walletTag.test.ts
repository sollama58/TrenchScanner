import { describe, expect, it } from "vitest";
import { walletTag } from "./walletTag.js";

describe("walletTag", () => {
  const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

  it("is stable, short and never contains the wallet", () => {
    expect(walletTag(wallet)).toBe(walletTag(wallet));
    expect(walletTag(wallet)).toMatch(/^[0-9a-f]{12}$/);
    expect(walletTag(wallet)).not.toContain(wallet.slice(0, 4));
  });

  it("tells wallets apart", () => {
    expect(walletTag(wallet)).not.toBe(walletTag("So11111111111111111111111111111111111111112"));
  });
});
