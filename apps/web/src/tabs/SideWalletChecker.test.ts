import { describe, expect, it } from "vitest";
import { sideLabelsText } from "./SideWalletChecker";

describe("sideLabelsText", () => {
  it("writes one address,KOL_N per line", () => {
    const row = (wallet: string, name: string) => ({
      wallet,
      kolWallet: "K",
      kolName: "Cupsey",
      kind: "possible",
      name,
    });
    expect(sideLabelsText({ count: 2, wallets: [row("A1", "Cupsey_1"), row("B2", "Cupsey_2")] })).toBe(
      "A1,Cupsey_1\nB2,Cupsey_2\n",
    );
  });
});
