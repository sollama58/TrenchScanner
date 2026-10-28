import { describe, expect, it } from "vitest";
import { bwamDevSideExportWallets } from "./kolSideExport.js";

describe("bwamDevSideExportWallets", () => {
  it("numbers listed wallets by % shared and skips bots and wallets already in the export", () => {
    const listed = [
      { wallet: "a", pct: 90 },
      { wallet: "b", pct: 95 },
      { wallet: "c", pct: 80 },
      { wallet: "bot", pct: 99 },
    ];
    const out = bwamDevSideExportWallets(listed, new Set(["bot"]), new Set(["a"]), "bwam_dev");
    expect(out).toEqual([
      { wallet: "b", name: "bwam_dev_1" },
      { wallet: "c", name: "bwam_dev_2" },
    ]);
  });

  it("continues the numbers after bwam_dev's labeled sides", () => {
    const out = bwamDevSideExportWallets([{ wallet: "b", pct: 95 }], new Set(), new Set(), "bwam_dev", 4);
    expect(out).toEqual([{ wallet: "b", name: "bwam_dev_4" }]);
  });
});
