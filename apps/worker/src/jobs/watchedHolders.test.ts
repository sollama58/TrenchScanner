import { describe, expect, it } from "vitest";
import { narrowWatchedMints, watchedMintsAfterFailure, WATCHED_HOLDERS_WINDOW_MS } from "./watchedHolders.js";

describe("watched holder stamps", () => {
  it("keeps only this cycle's candidates, newest first, within the 50", () => {
    const newest = ["a", "b", "c", "d"];
    expect([...narrowWatchedMints(newest, new Set(["b", "d", "z"]))]).toEqual(["b", "d"]);
    expect([...narrowWatchedMints(newest, undefined, 2)]).toEqual(["a", "b"]);
  });

  it("drops a failed read's mints once the window has passed, and drops a mint that left the candidates", () => {
    const previous = new Set(["live", "dead"]);
    const now = 1_000_000;
    expect([...watchedMintsAfterFailure(previous, now - 1_000, now, new Set(["live"]))]).toEqual(["live"]);
    expect(
      watchedMintsAfterFailure(previous, now - WATCHED_HOLDERS_WINDOW_MS - 1, now, new Set(["live", "dead"]))
        .size,
    ).toBe(0);
  });
});
