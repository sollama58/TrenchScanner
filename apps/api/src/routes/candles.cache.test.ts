import { describe, expect, it } from "vitest";
import { candleCacheControl } from "./candles.js";

const bar = { t: 0, o: 1, h: 1, l: 1, c: 1 };

describe("candleCacheControl", () => {
  it("keeps older pages a minute, whatever they hold", () => {
    expect(candleCacheControl(1_000, "1m", { bars: [] })).toBe("private, max-age=60");
    expect(candleCacheControl(1_000, "1m", { bars: [bar], holes: [[0, 1]] })).toBe("private, max-age=60");
  });

  it("keeps a complete newest page a few seconds", () => {
    expect(candleCacheControl(null, "1s", { bars: [bar] })).toBe("private, max-age=3");
    expect(candleCacheControl(null, "1m", { bars: [bar], holes: [] })).toBe("private, max-age=15");
  });

  // The chart re-reads a waiting page 3 seconds later; a browser cache must not answer that.
  it("lets the browser keep no newest page that is still waiting on data", () => {
    expect(candleCacheControl(null, "1m", { bars: [] })).toBe("private, no-cache");
    expect(candleCacheControl(null, "1m", { bars: [bar], holes: [[0, 60_000]] })).toBe("private, no-cache");
  });
});
