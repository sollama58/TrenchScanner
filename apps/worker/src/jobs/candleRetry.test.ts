import { describe, expect, it } from "vitest";
import { CandleRetry, GIVE_UP_TRIES, givesUp, pumpPausedNoKey, RETRY_FIRST_MS } from "./candleRetry.js";
import { CandlesUnavailableError, PUMP_PAUSED_NO_KEY } from "./minuteCandleReader.js";

const MIN = 60_000;

describe("CandleRetry", () => {
  it("waits 10 minutes after a miss, doubling to 6 hours, and forgets a coin answered", () => {
    const retry = new CandleRetry();
    let now = 0;
    const waits: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      expect(retry.miss("t", now)).toBe(i + 1);
      let wait = 0;
      while (retry.blocked(now + wait * MIN).includes("t")) wait += 1;
      waits.push(wait);
      now += wait * MIN;
    }
    expect(waits).toEqual([10, 20, 40, 80, 160, 320, 360, 360]);
    retry.forget("t");
    expect(retry.blocked(now)).toEqual([]);
    expect(retry.miss("t", now)).toBe(1);
    expect(retry.blocked(now + RETRY_FIRST_MS - 1)).toEqual(["t"]);
  });

  it("gives up after GIVE_UP_TRIES misses, however old the row", () => {
    expect(givesUp(GIVE_UP_TRIES - 1)).toBe(false);
    expect(givesUp(GIVE_UP_TRIES)).toBe(true);
  });

  it("tells Pump.fun's pause without a CoinGecko key from a coin's own miss", () => {
    expect(pumpPausedNoKey(new CandlesUnavailableError("m", PUMP_PAUSED_NO_KEY))).toBe(true);
    expect(pumpPausedNoKey(new CandlesUnavailableError("m", "no pools to ask"))).toBe(false);
    expect(pumpPausedNoKey(new Error(PUMP_PAUSED_NO_KEY))).toBe(false);
  });
});
