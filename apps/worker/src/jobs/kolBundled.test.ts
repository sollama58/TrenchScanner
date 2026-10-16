import { describe, expect, it } from "vitest";
import type { LinkedWalletsReading } from "@trenchscanner/core";
import { kolBundledByMint } from "./kolBundled.js";

const reading = (holders: { wallet: string; pct: number }[]): LinkedWalletsReading =>
  ({ holders, clusters: [], sameTimeClusters: [] }) as unknown as LinkedWalletsReading;

describe("kolBundledByMint", () => {
  const readings = new Map<string, LinkedWalletsReading | null>([
    [
      "A",
      reading([
        { wallet: "kol", pct: 3 },
        { wallet: "fundedByKol", pct: 2 },
        { wallet: "side", pct: 1 },
      ]),
    ],
    ["B", reading([{ wallet: "x", pct: 5 }])],
    ["C", null],
  ]);
  const funderOf = new Map([["fundedByKol", "kol"]]);
  const isKol = (w: string) => w === "kol";

  it("follows the bundle's transfers, keeping the models' figures without them", async () => {
    const sent = new Map([
      [
        "T",
        {
          ...reading([
            { wallet: "kol", pct: 3 },
            { wallet: "side", pct: 1 },
            { wallet: "got", pct: 0.8 },
          ]),
          transfers: [{ from: "side", to: "got", pct: 0.8 }],
        },
      ],
    ]);
    const out = await kolBundledByMint(sent, new Map(), isKol, async () => [
      { wallet: "side", kolWallet: "kol" },
    ]);
    expect(out.get("T")).toMatchObject({
      kolBundledPct: 4.8,
      kolBundledPctModel: 4,
      bundledSupplyPctModel: 4,
    });
  });
  it("counts the KOL, the wallet it funded and its possible side wallet", async () => {
    const out = await kolBundledByMint(readings, funderOf, isKol, async () => [
      { wallet: "side", kolWallet: "kol" },
    ]);
    expect(out.get("A")).toEqual({
      kolBundledPct: 6,
      bundledSupplyPct: 6,
      bundledSupplyCount: 3,
      kolBundledPctModel: 6,
      bundledSupplyPctModel: 6,
    });
    expect(out.get("B")).toEqual({
      kolBundledPct: 0,
      bundledSupplyPct: 0,
      bundledSupplyCount: 0,
      kolBundledPctModel: 0,
      bundledSupplyPctModel: 0,
    });
    expect(out.has("C")).toBe(false);
  });
  it("is unknown without the roster or when the side read fails", async () => {
    expect((await kolBundledByMint(readings, funderOf, undefined, async () => [])).size).toBe(0);
    const failed = await kolBundledByMint(readings, funderOf, isKol, async () => {
      throw new Error("db down");
    });
    expect(failed.size).toBe(0);
  });
});
