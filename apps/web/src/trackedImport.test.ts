import { describe, expect, it } from "vitest";
import { labelExport, parseLabelImport } from "./trackedImport";

const A = "So11111111111111111111111111111111111111112";
const B = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("parseLabelImport", () => {
  it("reads our own export back", () => {
    const text = labelExport([
      { wallet: A, name: "Alpha", category: "kol" },
      { wallet: B, name: "Beta", category: "tracked" },
    ]);
    expect(parseLabelImport(text)).toEqual({
      entries: [
        { wallet: A, name: "Alpha", kol: true },
        { wallet: B, name: "Beta", kol: false },
      ],
      skipped: 0,
    });
  });

  it("reads an address-to-name map", () => {
    expect(parseLabelImport(JSON.stringify({ [A]: "Alpha", nope: "x" }))).toEqual({
      entries: [{ wallet: A, name: "Alpha", kol: false }],
      skipped: 1,
    });
  });

  it("reads other trackers' keys, nested under a list key", () => {
    const text = JSON.stringify({
      wallets: [
        { trackedWalletAddress: A, label: "Alpha", category: "KOL" },
        { address: B, alias: "Beta" },
        { address: B },
        "junk",
      ],
    });
    expect(parseLabelImport(text)).toEqual({
      entries: [
        { wallet: A, name: "Alpha", kol: true },
        { wallet: B, name: "Beta", kol: false },
      ],
      skipped: 2,
    });
  });

  it("keeps a wallet's last entry", () => {
    const text = JSON.stringify([
      { wallet: A, name: "Old" },
      { wallet: B, name: "Beta" },
      { wallet: A, name: "New" },
    ]);
    expect(parseLabelImport(text).entries).toEqual([
      { wallet: B, name: "Beta", kol: false },
      { wallet: A, name: "New", kol: false },
    ]);
  });

  it("explains a file it can't read", () => {
    expect(() => parseLabelImport("{oops")).toThrow("valid JSON");
    expect(() => parseLabelImport("42")).toThrow("list of wallets");
  });
});
