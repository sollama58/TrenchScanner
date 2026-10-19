import { describe, expect, it } from "vitest";
import { knownText, labelExport, parseLabelImport } from "./trackedImport";

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

describe("parseLabelImport limits", () => {
  it("shortens long names so a full list fits the API's body limit", () => {
    const long = "🐳".repeat(200);
    const { entries } = parseLabelImport(
      JSON.stringify(Array.from({ length: 250 }, () => ({ wallet: A, name: long }))),
    );
    expect([...entries[0]!.name]).toHaveLength(40);
    const body = JSON.stringify({
      wallets: Array.from({ length: 250 }, () => ({ wallet: B, name: entries[0]!.name, kol: true })),
    });
    expect(new TextEncoder().encode(body).length).toBeLessThan(64 * 1024);
  });

  it("treats markup and __proto__ keys as plain data", () => {
    const text = `[{"wallet":"${A}","name":"<img src=x onerror=alert(1)>","__proto__":{"polluted":true}}]`;
    const { entries } = parseLabelImport(text);
    expect(entries[0]!.name).toBe("<img src=x onerror=alert(1)>");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("knownText", () => {
  it("names the label TrenchScanner already shows for a rejected entry", () => {
    expect(knownText({ wallet: "w", label: "Cupsey", kind: "kol" })).toBe("KOL: Cupsey");
    expect(knownText({ wallet: "w", label: "Cupsey Known Side", kind: "kol-side" })).toBe(
      "Cupsey Known Side",
    );
    expect(knownText({ wallet: "w", label: "Binance", kind: "exchange" })).toBe("Exchange: Binance");
    expect(knownText({ wallet: "w", label: null, kind: "bot" })).toBe("Marked bot");
  });
});
