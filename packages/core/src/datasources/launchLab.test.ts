import { describe, expect, it } from "vitest";
import { decodeLaunchLab } from "./launchLab.js";

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
