import { describe, expect, it } from "vitest";
import { pumpSwapPoolOf } from "../datasources/pumpSwapPool.js";
import { tradesFromLogs } from "./pumpTradeEvents.js";

/*
 * Real mainnet events (2026-10-19), each checked against its transaction: the user is the signer,
 * the SOL matches the signer's balance change, and a PumpSwap event's reserves moved by what the
 * pool's vaults show before and after.
 */

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

/** Tx 3wK3u2u5WTZF...: a curve sell (SellV3), its whole log. */
const CURVE_SELL_LOGS = [
  "Program 11111111111111111111111111111111 invoke [1]",
  "Program 11111111111111111111111111111111 success",
  "Program ComputeBudget111111111111111111111111111111 invoke [1]",
  "Program ComputeBudget111111111111111111111111111111 success",
  "Program ComputeBudget111111111111111111111111111111 invoke [1]",
  "Program ComputeBudget111111111111111111111111111111 success",
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
  "Program log: Instruction: SellV3",
  "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]",
  "Program log: Instruction: TransferChecked",
  "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb consumed 2562 of 17716 compute units",
  "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb success",
  "Program data: vdt/007mYe57UWQtYHszYJzT83b9CYgKJ7zrx5AJJkfG+wN0h58NH8TAZwAAAAAA1W9FzawkAAAAER1U4rad3LCdGm4TCdz0ZxpDgxOVt93LgYgQGyogGKHDX9VqAAAAAOEkuwYAAAAAzrbQUseFAgAf4TYEAAAAAM4evgY2hwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABfAAAAAAAAAFT8AAAAAAAAixcXNVNntyTIgEFjuwzSQL4zAq4SExOv6UGOwli6+bseAAAAAAAAAK9PAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAHNlbGwBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADEwGcAAAAAAOEkuwYAAAAAH+E2BAAAAAAAAAAAAAAAAAAAAAAAAAAALYMqAAAAAAA=",
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [2]",
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P consumed 2170 of 7882 compute units",
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P consumed 43641 of 47050 compute units",
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
  "Program 11111111111111111111111111111111 invoke [1]",
  "Program 11111111111111111111111111111111 success",
];
const CURVE_SELL_MINT = "9JP8XNc6tJ5M49AvAgdDwh9xUzjWNG5EgN3jUzWgpump";

/** Tx 5q1Dm415txcA...: a curve buy inside an aggregator route. */
const CURVE_BUY =
  "Program data: vdt/007mYe7GY4VngARBWxnx9n8TLxwqEJZgKF8UwbBe76KnCY1DH09slQAAAAAACUsOUhwAAAABhe56iadlhK4Rt5aGTh8INt5/FFeC7y9dAmTuBveO3UTDX9VqAAAAAHH8l9oLAAAAGK3IIws/AgBxUHTeBAAAABgVttd5QAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABfAAAAAAAAAGZrAQAAAAAAyoJa+r0RynnxudQ0rycimcREoNrObmZ06rSs5UgXkCgeAAAAAAAAAMJyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAGJ1eQAAAAAAAAAAAAAAAAAAAAAAiBMAAAAAAACztQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE9slQAAAAAAcfyX2gsAAABxUHTeBAAAAAAAAAAAAAAAAAAAAAAAAAArP803AAAAAA==";
const CURVE_BUY_MINT = "EMRjzAdUDeKZi6w32yGJiERb7W9spV6UuL7827zUpump";

/** Tx 27R2ctS3yu7t...: a plain PumpSwap buy (the user paid field 13). */
const POOL_BUY =
  "Program data: Z/RSHyz1d3cOYNVqAAAAAHd5FwIAAAAAMuq0AAAAAACJrNNNBwAAADLqtAAAAAAApwum4ecGAAD0FjVGGQIAAN/5owAAAAAAFAAAAAAAAAD1UwAAAAAAAAUAAAAAAAAA/hQAAAAAAADUTaQAAAAAANB3pAAAAAAAnPF45zH5ZXoSaPVsBXHTO71pUR1DY5QmvZGRArbWVbXM/uQMQuYifi8z9jnDk4futf/PIPYOdBL4jBGQ9Quaqv8MyC3oHTZoPtccMj43mML4vkOCW43MwAmOMDmUNkmUvUlRdtqw4qmljeFsMbm2pg4ipr7w6KS+JPi1Z0KkvpLXqo+wYNgpG0xNR12v92LJa9wNrOs2wBLq0S7TqUhBYQHIIfOo8I/viNwxQkp2gK6MloFwTPHl9ciOJ5m3+YIhNFTM6uiZ7/biKWFPOR3CNLWQgk45Z+96dzFPhTIf6lsFAAAAAAAAAP4UAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAd3kXAgAAAAADAAAAYnV5AAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAAfwoAAAAAAADsJhIYBAAAAAAAAAAAAAAAAesaq9ttjQMAAAAAAAAAAAAAAAAAAAAAANwaDAAAAAAA";
const POOL_BUY_MINT = "CWjjGnhvfRzu2qb8ocL6NxprzLv31VfiCjcvVYARpump";

/** Tx 4svBm7fEmDjz...: a PumpSwap buy_exact_quote_in (the user paid field 7). */
const POOL_EXACT_BUY =
  "Program data: Z/RSHyz1d3evX9VqAAAAAJepjgAAAAAAPnsCAAAAAAAkfUgEAAAAAD57AgAAAAAAupgczyAdAAAfIZxyfAAAAD57AgAAAAAAFAAAAAAAAABDAQAAAAAAAAUAAAAAAAAAUQAAAAAAAADVdgIAAAAAAJJ1AgAAAAAAaoLOn90j25/bjaNFdtkg1TpXA3/56FJim1iK8mPSNqgYEAB8FMXhlUMnIscoHkeAFxKkFy91uo7FmawQq9JY0NcpaY3qRE3ZIUJfBcuIhbN+TJWqobYx73ZiP0IeGUWNOWB8/0/AO8L+HDLCxIzquzNcb1aftTzjh/cd+kn/cwPgBMh865j6XOR/gDgG/Sx5RdKVJJWa7ADe2XgU8494RpwlJHx6/mh3nE583EE55WuEze54pO2bR06h+o7pPOIl0graGKI1um8A//F7ICJ3I9N1I1BEeRdb8Ld7gj2tIj9BAAAAAAAAABgEAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJM+LAAAAAAASAAAAYnV5X2V4YWN0X3F1b3RlX2luAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAAKAAAAAAAAADIQR4YBAAAAAAAAAAAAAAAAVolFaNPiQMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const POOL_EXACT_BUY_MINT = "TgTBjtPdQKbPgsrWqEZiQKMqnh3DYEktnWVwRoLpump";

/** Tx mqfXG15a77Ze...: a PumpSwap sell. */
const POOL_SELL =
  "Program data: Pi83CqUD3CqvX9VqAAAAAOknSAAAAAAAEDIBAAAAAACi7Xd9AAAAAAAAAAAAAAAAaTuL29IcAAByAQjGfQAAABpFAQAAAAAAFAAAAAAAAACnAAAAAAAAAAUAAAAAAAAAKgAAAAAAAABzRAEAAAAAACxCAQAAAAAA/jC8EwgnTR9BG5fZ+NKS9/W3d4k8B95syvO5n8GqHzHEAzPWPlTeLahCX3c4KI6AGwBMj9cviqKDuLlLSX+y5h8q8+57COE/Z2vbATQyDLjkfUZYibVDjJo44lRrPUedwIiUy9FKxUBs2XmD1ZXCtLOH26+nOdAKOXvDLGI5bPiDhHQpLmdalLQ27LCpmIlCMoqD3cYjOAKWEmfFzWEXy6JjF6U7oP1oxMlT7DDw4JuOc2h1HLKBVIbK4+mdCvndUSkczLZhfUQnnpRhFt2COIHBogJMVWyh3/tiwptu8WVBAAAAAAAAAB0CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAAFQAAAAAAAAAccNIXBAAAAAAAAAAAAAAAARrvtnJPiQMAAAAAAAAAAAAAAAAAAAAAAMsCSQAAAAAA";
const POOL_SELL_MINT = "rEG77ZMAtX6RonsGjMfvnqAgt5xhga6SctCmFUUpump";

/**
 * Tx on JUWr8a7F... (2026-10-19): a buy_exact_quote_in on a curve quoted in PUMP, whose SOL
 * fields are all 0; the trade is in the quote fields (19,749.77 PUMP, the 0.95% fee beside it).
 */
const QUOTED_BUY =
  "Program data: vdt/007mYe4EefwP3cchKbCVnjgB7oFYY7TGdmM3vMpau+JwwUchvwAAAAAAAAAAjB3eWwYCAAABSAXf5Ev3tAOUy9CFSJdS1kaiJf14Q0ICGWucRrr0JHVZh9VqAAAAAAAAAAAAAAAArvhioVMZAQAAAAAAAAAAAK5gUFXCGgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABfAAAAAAAAAH/lLgsAAAAAwyyVQNdTpazG91n/Uc1Y9YuAVeMG+N+0YpFtmELZdIlkAAAAAAAAAEKTxQsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEgAAAGJ1eV9leGFjdF9xdW90ZV9pbgAAAAAAAAAAAAAAAAAAAAAAiBMAAAAAAAC/cpcFAAAAAAAAAAAMRfffjZ5ylWKEkz9tmLdXAy6D34RgT7XhF//2HVsS+beFLZkEAAAA9n+ne4MCAABRuDH7yQEAAGQAAAAAAAAAQpPFCwAAAAAkgPG6CQAAAA==";
const QUOTED_MINT = "JUWr8a7Fx9kYwA3fZJom9L9si4EmekTFkDbcrJipump";
const PUMP_TOKEN = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";

/** `line` as `program` logged it: inside its own invoke frame. */
const framed = (program: string, ...lines: string[]) => [
  `Program ${program} invoke [1]`,
  "Program log: Instruction: Swap",
  ...lines,
  `Program ${program} consumed 40000 of 200000 compute units`,
  `Program ${program} success`,
];

describe("tradesFromLogs", () => {
  it("reads a curve sell from its whole real log", () => {
    expect(tradesFromLogs(CURVE_SELL_LOGS, { mint: CURVE_SELL_MINT })).toEqual([
      {
        wallet: "29osZx6o2d3CQMpzajE8cyvB9EdYeGhmaFda13CMLoCL",
        side: "sell",
        sol: 0.006799556,
        tokens: 40324596.854741,
        atMs: 1792368579000,
        // Virtual reserves after it: 112927969 lamports over 710041087817422 base units.
        priceSol: 0.112927969 / 710041087.817422,
      },
    ]);
  });

  it("reads a curve buy and skips it for another mint", () => {
    const logs = framed(PUMP, CURVE_BUY);
    expect(tradesFromLogs(logs, { mint: CURVE_BUY_MINT })).toEqual([
      {
        wallet: "A1p8rxcap2fsswEBAQwjzZ2LneiYHJcfA5H3udXKK9wy",
        side: "buy",
        sol: 0.009792591,
        tokens: 121635.752713,
        atMs: 1792368579000,
        priceSol: 50.912033905 / 632267030.965528,
      },
    ]);
    expect(tradesFromLogs(logs, { mint: CURVE_SELL_MINT })).toEqual([]);
  });

  it("reads PumpSwap buys and sells for the coin's pool, priced after the swap", () => {
    expect(pumpSwapPoolOf(POOL_BUY_MINT)).toBe("BZeAHmcfaFCXUE3txVs5PVVHoZ88ASmF79KYGsbWTqHv");
    expect(
      tradesFromLogs(framed(AMM, POOL_BUY), { mint: POOL_BUY_MINT, pool: pumpSwapPoolOf(POOL_BUY_MINT) }),
    ).toEqual([
      {
        wallet: "EoDbdYTHSFXzkeAbramNxGvPFhi9TPgipXdPirz8DXtu",
        side: "buy",
        sol: 0.010778576,
        tokens: 35.092855,
        atMs: 1792368654000,
        // The vaults after it, as the transaction's token balances show: 2307586090184 lamports
        // over 7592957874736 base units.
        priceSol: 2307.586090184 / 7592957.874736,
      },
    ]);
    expect(
      tradesFromLogs(framed(AMM, POOL_EXACT_BUY), {
        mint: POOL_EXACT_BUY_MINT,
        pool: pumpSwapPoolOf(POOL_EXACT_BUY_MINT),
      }),
    ).toMatchObject([
      {
        wallet: "2cvwLjo2Vdz6yZ8YRuJ9BeLYsDJSrWLggYqH4neX9x1M",
        side: "buy",
        sol: 0.000162622,
        tokens: 9.349527,
      },
    ]);
    expect(
      tradesFromLogs(framed(AMM, POOL_SELL), { mint: POOL_SELL_MINT, pool: pumpSwapPoolOf(POOL_SELL_MINT) }),
    ).toEqual([
      {
        wallet: "EC9jyvFPZPDU5K7vKSH3yZL3nQGZ7aCRa1iPbCePvcsX",
        side: "sell",
        sol: 0.000082476,
        tokens: 4.728809,
        atMs: 1792368559000,
        // 540193242367 lamports over 31691956773714 base units after it.
        priceSol: 540.193242367 / 31691956.773714,
      },
    ]);
  });

  it("skips pool events for another pool, or with no pool given", () => {
    const logs = framed(AMM, POOL_SELL);
    expect(tradesFromLogs(logs, { mint: POOL_BUY_MINT, pool: pumpSwapPoolOf(POOL_BUY_MINT) })).toEqual([]);
    expect(tradesFromLogs(logs, { mint: POOL_SELL_MINT })).toEqual([]);
  });

  it("only trusts an event inside its own program's frame", () => {
    // The same bytes logged by another program, or with no frame at all.
    const fake = "Fake111111111111111111111111111111111111111";
    expect(tradesFromLogs(framed(fake, CURVE_BUY), { mint: CURVE_BUY_MINT })).toEqual([]);
    expect(tradesFromLogs([CURVE_BUY], { mint: CURVE_BUY_MINT })).toEqual([]);
    // After an inner call returns, the outer frame is the curve's again.
    const nested = [
      `Program ${PUMP} invoke [1]`,
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      CURVE_BUY,
      `Program ${PUMP} success`,
    ];
    expect(tradesFromLogs(nested, { mint: CURVE_BUY_MINT })).toHaveLength(1);
  });

  it("reads every event of the coin in one transaction, in order", () => {
    const logs = framed(PUMP, CURVE_BUY, CURVE_BUY);
    expect(tradesFromLogs(logs, { mint: CURVE_BUY_MINT })).toHaveLength(2);
  });

  it("reads a curve quoted in another coin from its quote fields", () => {
    const [t] = tradesFromLogs(framed(PUMP, QUOTED_BUY), { mint: QUOTED_MINT });
    expect(t).toMatchObject({ side: "buy", sol: null, priceSol: null, tokens: 2226334.34254 });
    expect(t!.quote).toEqual({
      mint: PUMP_TOKEN,
      amount: 19749766583,
      reserve: 2763738546166,
      tokenReserve: 309321957.30859,
    });
  });

  it("leaves a quoted trade out when its fee doesn't match its amount", () => {
    const data = Buffer.from(QUOTED_BUY.slice("Program data: ".length), "base64");
    // The protocol fee, doubled: the quote fields aren't where this reads them.
    data.writeBigUInt64LE(data.readBigUInt64LE(169) * 2n, 169);
    const line = `Program data: ${data.toString("base64")}`;
    expect(tradesFromLogs(framed(PUMP, line), { mint: QUOTED_MINT })).toEqual([]);
  });

  it("never throws on garbage", () => {
    const junk = [
      "Program data: ",
      "Program data: !!!not base64!!!",
      "Program data: " + Buffer.from([189, 219, 127, 211, 78, 230, 97, 238, 1, 2]).toString("base64"),
      "Program data: " + CURVE_BUY.slice(14, 60),
      "Program X success",
      42 as unknown as string,
      null as unknown as string,
    ];
    expect(tradesFromLogs(framed(PUMP, ...junk), { mint: CURVE_BUY_MINT })).toEqual([]);
    expect(tradesFromLogs(framed(AMM, ...junk), { mint: CURVE_BUY_MINT, pool: "x" })).toEqual([]);
    expect(tradesFromLogs(null as unknown as string[], { mint: CURVE_BUY_MINT })).toEqual([]);
  });
});
