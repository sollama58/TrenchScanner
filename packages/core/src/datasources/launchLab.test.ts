import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import {
  RAYDIUM_CPMM_LOCK_AUTHORITY,
  cpmmLpFor,
  cpmmVaultsFor,
  decodeLaunchLab,
  lockedLpShare,
} from "./launchLab.js";

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

/** DER1K...WTsZ's CPMM pool against SAMA4 (2cvpE...PYZ), its first 341 bytes, read off mainnet 2026-10-19. */
const CPMM_POOL =
  "9+3j9dfD3kapsh8XfpuXbo7hKfQa7zeEqsUUlJCVsALmEX1Z0DaWjz5PhCp9CwyeyOJOoDoxyfh5o13DBHWJGqruXZ6wCC/5lftW7PNAYDDquYTQp9oQmoOEWrkglMsIp8deFGUNTOmoCHevICU2d16J5mJuUSpfdABY+EsfjKDU7h75xKg8DJiUBKg8tU3J68GN9TVkQHoMuoagdgGCiEhAC9DoztY3YFMfo16VImaLs+5MBzDSIGYDuA8D/HC9v7HLKf1ZUUu1u+/RTZoLPwUyVYZjdhDOhKPGxFYzM3QYkLwvNgclxAbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpBt324e51j94YQl285GzN2rYa/E2DuQ0n/r35KNihi/wlrw0NryIqbyYt7zgf0AnxTLmBQXyIk2gfJPOdD1EZv/0ACQYGHKaR0TUBAAA=";

describe("cpmmLpFor", () => {
  it("reads a live CPMM pool's LP mint and issued LP", () => {
    expect(cpmmLpFor(CPMM_POOL, "DER1KeNskuJuBh8roxvSD6iuJhSFFAYKqsa5WZbfWTsZ")).toEqual({
      lpMint: "BGbsvvgd1hzRuaTJL88CMqxVbUyCceLN6Vc2JYaoCPan",
      lpSupply: 1330660877852n,
    });
    expect(cpmmLpFor(CPMM_POOL, "So11111111111111111111111111111111111111112")).toBeNull();
    expect(cpmmLpFor(new Uint8Array(100), "DER1KeNskuJuBh8roxvSD6iuJhSFFAYKqsa5WZbfWTsZ")).toBeNull();
  });
});

describe("lockedLpShare", () => {
  it("counts LP burned and LP in Raydium's lock, nothing a wallet holds", () => {
    // The live pool: the CPMM's own 100 locked units burned, every other LP token in the lock.
    expect(RAYDIUM_CPMM_LOCK_AUTHORITY).toBe("3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH");
    expect(
      lockedLpShare(1330660877852n, 1330660877752n, [
        { owner: RAYDIUM_CPMM_LOCK_AUTHORITY, amount: 1330660877752n },
      ]),
    ).toBe(1);
    expect(lockedLpShare(1000n, 600n, [{ owner: "Wallet", amount: 600n }])).toBeCloseTo(0.4);
    expect(lockedLpShare(1000n, 1000n, [{ owner: "Wallet", amount: 1000n }])).toBe(0);
    expect(lockedLpShare(0n, 0n, [])).toBeNull();
  });
});
