import { describe, expect, it } from "vitest";
import {
  flaggedText,
  labelBasis,
  labelPill,
  pinLabeled,
  sideLabelsForExport,
  sideLabelsText,
  type SideWallet,
} from "./SideWalletChecker";

describe("flaggedText", () => {
  it("counts the flagged wallets", () => {
    expect(flaggedText(1)).toBe("1 Flagged Wallet");
    expect(flaggedText(1200)).toBe("1,200 Flagged Wallets");
  });
});

describe("sideLabelsForExport", () => {
  const base = {
    count: 1,
    wallets: [{ wallet: "L1", name: "Cupsey_1" }],
    bwamDevSide: {
      count: 2,
      wallets: [
        { wallet: "B1", name: "bwam_dev_1" },
        { wallet: "B2", name: "bwam_dev_2" },
      ],
    },
  };

  it("leaves the export unchanged when the toggle is off", () => {
    expect(sideLabelsForExport(base, false)).toEqual({
      count: 1,
      wallets: base.wallets,
      bwamDevSide: base.bwamDevSide,
    });
    expect(sideLabelsText(sideLabelsForExport(base, false))).toBe("L1,Cupsey_1\n");
  });

  it("appends bwam_dev sides when the toggle is on and matches the displayed count", () => {
    const out = sideLabelsForExport(base, true);
    expect(out.count).toBe(3);
    expect(out.wallets).toHaveLength(3);
    expect(out.bwamDevSide?.count).toBe(2);
    expect(sideLabelsText(out)).toBe("L1,Cupsey_1\nB1,bwam_dev_1\nB2,bwam_dev_2\n");
  });
});

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

describe("pinLabeled", () => {
  const row = (wallet: string, pct: number): SideWallet => ({
    wallet,
    pct,
    shared: 5,
    coins: 10,
    gapSec: 3,
    risk: null,
  });
  it("pins every labeled wallet whatever the window: listed ones by the list's order, then the rest", () => {
    const list = [row("a", 90), row("b", 80), row("c", 70)];
    const { pinned, rest } = pinLabeled(list, [
      { wallet: "x", kind: "funded", pct: 0 },
      { wallet: "c", kind: "possible", pct: 95 },
      { wallet: "a", kind: "possible", pct: 60 },
    ]);
    expect(pinned.map((p) => [p.wallet, p.stats?.pct ?? null])).toEqual([
      ["a", 90],
      ["c", 70],
      ["x", null],
    ]);
    expect(rest.map((r) => r.wallet)).toEqual(["b"]);
  });
  it("leaves the list as it is with no labels (older API builds)", () => {
    const list = [row("a", 90)];
    expect(pinLabeled(list, undefined)).toEqual({ pinned: [], rest: list });
  });
});

describe("labelPill and labelBasis", () => {
  it("names the label and what earned it", () => {
    expect(labelPill({ wallet: "w", kind: "known", pct: 100 })).toBe("Known Side");
    expect(labelPill({ wallet: "w", pct: 90 })).toBe("Labeled");
    expect(labelBasis({ wallet: "w", kind: "possible", pct: 95.6, hours: 48, transfers: 4 })).toBe(
      "96% shared over 48h · 4 transfers",
    );
    expect(labelBasis({ wallet: "w", kind: "possible", pct: 0, hours: 72, transfers: 12 })).toBe(
      "12 transfers within 72h",
    );
    expect(labelBasis({ wallet: "w", pct: 92, hours: 24, transfers: 4, transferHours: 48 })).toBe(
      "92% shared over 24h · 4 transfers within 48h",
    );
    expect(labelBasis({ wallet: "w", kind: "funded", pct: 0 })).toBe("The KOL paid for its first SOL");
  });
});
