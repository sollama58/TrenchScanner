import { describe, expect, it } from "vitest";
import { pickWalletName } from "./walletNames.js";

const identity = { type: "exchange", name: "OKX 2", category: "Centralized Exchange", tags: [] };

describe("pickWalletName", () => {
  it("drops a trailing X handle from any name, cached identities included (user ask 2026-10-16)", () => {
    const named = { type: "other", name: "Gake @gake_sol", category: null, tags: [] };
    expect(pickWalletName({ kol: null, identity: named, exchange: null })?.name).toBe("Gake");
    expect(pickWalletName({ kol: "Ansem @blknoiz06", identity: null, exchange: null })?.name).toBe("Ansem");
  });
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

  it("names a KOL's Known Side as one, ahead of any other name", () => {
    expect(pickWalletName({ kol: null, kolSide: "Cupsey Known Side", identity, exchange: "OKX" })).toEqual({
      name: "Cupsey Known Side",
      source: "kol-side",
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
