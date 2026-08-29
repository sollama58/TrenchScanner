// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { computeEmptyPct, type WalletHoldings } from "./walletHoldings.js";

const MIN_USD = 25;
const LAUNCH = "LaunchMint1111111111111111111111111111111111";
const OTHER_LAUNCH = "OtherMint22222222222222222222222222222222222";

/**
 * Builds readings the way the resolver does: `total` is everything non-cash the wallet holds,
 * INCLUDING the launch, and the launch's own share is carried separately so it can come back out.
 */
const holdings = (
  entries: Record<string, { total: number; ofLaunch?: number; ofOther?: number }>,
): Map<string, WalletHoldings> =>
  new Map(
    Object.entries(entries).map(([address, v]) => [
      address,
      {
        otherHoldingsUsd: v.total,
        perMintUsd: {
          [LAUNCH]: v.ofLaunch ?? 0,
          ...(v.ofOther === undefined ? {} : { [OTHER_LAUNCH]: v.ofOther }),
        },
      },
    ]),
  );

describe("computeEmptyPct", () => {
  it("counts a wallet holding nothing but the launch as empty", () => {
    // The bug this signal exists to catch, and the one it used to miss: a shell funded to hold
    // one launch and nothing else. Its $3,000 of the launch token used to count as "other
    // holdings" and score it among the richest wallets on the list.
    const pct = computeEmptyPct(
      ["shell"],
      holdings({ shell: { total: 3_000, ofLaunch: 3_000 } }),
      MIN_USD,
      LAUNCH,
    );
    expect(pct).toBe(100);
  });

  it("does not count a wallet that trades other things as empty", () => {
    // Same $3,000 of the launch, but this wallet also holds $500 of other tokens - a real trader
    // who happens to be in this one. The distinction is the entire signal.
    const pct = computeEmptyPct(
      ["trader"],
      holdings({ trader: { total: 3_500, ofLaunch: 3_000 } }),
      MIN_USD,
      LAUNCH,
    );
    expect(pct).toBe(0);
  });

  it("subtracts only the launch being scored, not every launch the wallet holds", () => {
    // Holding OTHER_LAUNCH is evidence this wallet trades the market, so it must survive the
    // subtraction. Excluding every candidate mint at once would wrongly empty this wallet out.
    const wallet = holdings({ w: { total: 3_400, ofLaunch: 3_000, ofOther: 400 } });
    expect(computeEmptyPct(["w"], wallet, MIN_USD, LAUNCH)).toBe(0);
    expect(computeEmptyPct(["w"], wallet, MIN_USD, OTHER_LAUNCH)).toBe(0);
  });

  it("counts wallets under the bar, and only those", () => {
    // Two shells (under $25 besides the launch), two real wallets - the shape the filter catches.
    const pct = computeEmptyPct(
      ["a", "b", "c", "d"],
      holdings({
        a: { total: 900, ofLaunch: 900 },
        b: { total: 912.5, ofLaunch: 900 },
        c: { total: 925, ofLaunch: 900 },
        d: { total: 5_100, ofLaunch: 900 },
      }),
      MIN_USD,
      LAUNCH,
    );
    expect(pct).toBe(50);
  });

  it("treats the threshold itself as holding enough", () => {
    // Exactly $25 besides the launch is not empty - the bar is "less than".
    expect(computeEmptyPct(["a"], holdings({ a: { total: 125, ofLaunch: 100 } }), MIN_USD, LAUNCH)).toBe(0);
    expect(computeEmptyPct(["a"], holdings({ a: { total: 124.99, ofLaunch: 100 } }), MIN_USD, LAUNCH)).toBe(
      100,
    );
  });

  it("returns null when ANY wallet went unpriced, rather than a part-checked percentage", () => {
    // The budget deferred "d". Three of four priced is not 'mostly right' here - quoting a
    // percentage over a list we only partly checked invents a number.
    const some = holdings({ a: { total: 0 }, b: { total: 0 }, c: { total: 0 } });
    expect(computeEmptyPct(["a", "b", "c", "d"], some, MIN_USD, LAUNCH)).toBeNull();
  });

  it("returns null when a reading never covered the launch being scored", () => {
    // A cached row from before this wallet appeared on today's holder list has nothing to
    // subtract. Reporting it as unknown is right; subtracting zero would resurrect the bug.
    const stale = new Map<string, WalletHoldings>([
      ["a", { otherHoldingsUsd: 3_000, perMintUsd: { [OTHER_LAUNCH]: 0 } }],
    ]);
    expect(computeEmptyPct(["a"], stale, MIN_USD, LAUNCH)).toBeNull();
  });

  it("distinguishes 'nothing to check' from 'checked, none empty'", () => {
    expect(computeEmptyPct([], new Map(), MIN_USD, LAUNCH)).toBeNull();
    expect(computeEmptyPct(["a"], holdings({ a: { total: 1_000 } }), MIN_USD, LAUNCH)).toBe(0);
  });

  it("reports a whole sniper farm as 100%", () => {
    // Every wallet holds a slice of the launch and nothing else - the pure farm.
    const addresses = ["a", "b", "c", "d", "e"];
    const farm = holdings(Object.fromEntries(addresses.map((a) => [a, { total: 800, ofLaunch: 800 }])));
    expect(computeEmptyPct(addresses, farm, MIN_USD, LAUNCH)).toBe(100);
  });

  it("honours a caller-supplied threshold rather than a baked-in one", () => {
    // The bar is env-tunable (WALLET_HOLDINGS_MIN_USD); the same wallet flips sides with it.
    const wallets = holdings({ a: { total: 150, ofLaunch: 100 } });
    expect(computeEmptyPct(["a"], wallets, 25, LAUNCH)).toBe(0);
    expect(computeEmptyPct(["a"], wallets, 100, LAUNCH)).toBe(100);
  });

  it("never reports a negative balance as somehow non-empty", () => {
    // Defensive: the total is a floor and the launch figure comes from the same response, so
    // total < launch should not happen - but if it ever did, the wallet is empty, not rich.
    const odd = new Map<string, WalletHoldings>([
      ["a", { otherHoldingsUsd: 10, perMintUsd: { [LAUNCH]: 50 } }],
    ]);
    expect(computeEmptyPct(["a"], odd, MIN_USD, LAUNCH)).toBe(100);
  });
});
