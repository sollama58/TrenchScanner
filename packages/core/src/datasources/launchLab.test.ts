import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { cpmmVaultsFor, decodeLaunchLab } from "./launchLab.js";

/** A Stonks coin's LaunchLab pool, read off mainnet 2026-10-18 (8fmggHx…eAvx, KM / ELON). */
const POOL =
  "9+3j9dfD3kYlBAAAAAAAAPoABgYBAIDGpH6NAwAAeMX7UdECAPNwDj7pzwMAaVLd8SkBAAD1kBAgdZkBALIlGV7XAAAAcoAjJ0wDAAAkLbNQEgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAnbZmbcW0T4icLI3tnjkQ72wjyLTnRxwB6EBlp+S5PN1NF5467uId8T+hDkEHLNibXaPT5YpV3S7SudH4Btb6sUNepuhXeMnRCntqxt00IycjFyB95Swri7w49WiMnKFwApE8WTmT6T0RxqI+3ZoMZ1x/ZeuoinvipSCWY33tDJemIyDtVJA70pxTGes32S+ErGrCsO4E+lb5wbjo+h3yAbTJmdCHpqffZgoFPb9GF2b3OLWJIG2BSlxQkMzGEzjS08Knt5uty1Ic0Vu+/J/FdIj+cjRjG0JZZDOb30DrrAQDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("decodeLaunchLab", () => {
  it("reads a live LaunchLab pool's effective reserves and quote", () => {
    const s = decodeLaunchLab(POOL)!;
    expect(s.complete).toBe(false);
    expect(s.quoteIsSol).toBe(false);
    expect(s.quoteMint).toBe("B2GESkSErPjuCq6n4LcaJP5v2z1kJnw3xHVZnop2sZx");
    // GeckoTerminal priced it at 0.00358 ELON a token that minute; both coins have 6 decimals.
    expect(s.virtualQuote / s.virtualToken).toBeCloseTo(0.00354, 4);
  });

  it("is null for anything else, and priceless once graduated", () => {
    expect(decodeLaunchLab(new Uint8Array(429))).toBeNull();
    const done = Uint8Array.from(Buffer.from(POOL, "base64"));
    done[17] = 2;
    expect(decodeLaunchLab(done)).toMatchObject({ complete: true, virtualToken: 0 });
  });
});

describe("cpmmVaultsFor", () => {
  it("reads which vault holds the coin, whichever side of the pool it is on", () => {
    const keys = [
      "E7qAvoKmNsfpRZ8YUEvwoAWVs2J4QUgfmERu5cT9YiWv",
      "7uEj6ZjkPgwmNaak6CdoCvEXXp1fkSbfT4okUwsnkwW3",
    ];
    const [coin, quote] = [
      "Wr8xawXWMMBD6eWXPrf2t9kZzVwaMHLCJDRYc8zSTNK",
      "ysPp2Bt2j2UQu2tZwtSJz7JxyrmQ8GJcNJE5NyDoS5a",
    ];
    const slice = new Uint8Array(160);
    [keys[0]!, keys[1]!, keys[0]!, coin, quote].forEach((k, i) => slice.set(bs58.decode(k), i * 32));
    expect(cpmmVaultsFor(slice, coin, quote)).toEqual({ base: keys[0], quote: keys[1], virtualQuote: 0 });
    expect(cpmmVaultsFor(slice, quote, coin)).toEqual({ base: keys[1], quote: keys[0], virtualQuote: 0 });
    expect(cpmmVaultsFor(slice, coin, "So11111111111111111111111111111111111111112")).toBeNull();
  });
});
