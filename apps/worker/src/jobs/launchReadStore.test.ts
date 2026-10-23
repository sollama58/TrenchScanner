import { describe, expect, it } from "vitest";
import { revive } from "./launchReadStore.js";

describe("revive", () => {
  it("brings a saved reading back with its launch time as a Date", () => {
    const r = revive({
      buyers: [],
      supply: 1000,
      devBought: 0,
      createSlot: 7,
      launchAt: "2026-10-22T00:00:00.000Z",
    });
    expect(r?.launchAt).toEqual(new Date("2026-10-22T00:00:00.000Z"));
    expect(
      revive({ buyers: [], supply: 1000, devBought: 0, createSlot: null, launchAt: null })?.launchAt,
    ).toBeNull();
  });
  it("refuses a row that isn't a reading", () => {
    expect(revive(null)).toBeNull();
    expect(revive({ supply: 1 })).toBeNull();
  });
});
