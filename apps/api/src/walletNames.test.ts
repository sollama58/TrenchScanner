import { describe, expect, it } from "vitest";
import { pickWalletName } from "./walletNames.js";

const identity = { type: "exchange", name: "OKX 2", category: "Centralized Exchange", tags: [] };

describe("pickWalletName", () => {
  it("prefers the KOL name, then Helius's name, then the exchange list", () => {
    expect(pickWalletName({ kol: "Cupsey", identity, exchange: "OKX" })).toEqual({
      name: "Cupsey",
      source: "kol",
    });
    expect(pickWalletName({ kol: "", identity, exchange: "OKX" })).toEqual({
      name: "OKX 2",
      source: "identity",
    });
    expect(pickWalletName({ kol: null, identity: null, exchange: "OKX" })).toEqual({
      name: "OKX",
      source: "exchange",
    });
  });

  it("names nobody it knows nothing about", () => {
    expect(
      pickWalletName({ kol: null, identity: { ...identity, name: null }, exchange: undefined }),
    ).toBeNull();
  });

  it("marks a Pump.fun username", () => {
    expect(
      pickWalletName({ kol: null, identity: { ...identity, name: "degen", pumpfun: true }, exchange: null }),
    ).toEqual({
      name: "degen",
      source: "pumpfun",
    });
  });
});
