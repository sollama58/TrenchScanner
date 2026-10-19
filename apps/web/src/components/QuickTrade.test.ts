import { describe, expect, it } from "vitest";
import { marketNote } from "./QuickTrade";

describe("QuickTrade's market note", () => {
  it("tells a failed DexScreener read apart from no market", () => {
    expect(marketNote(true, null)).toMatch(/Reading/);
    expect(marketNote(false, null)).toMatch(/no market/);
    const failed = marketNote(false, "DexScreener couldn't be reached. Try again in a moment.");
    expect(failed).toMatch(/Couldn't read its market/);
    expect(failed).not.toMatch(/no market/);
    // Asking again: still reading, whatever the last attempt said.
    expect(marketNote(true, "timeout")).toMatch(/Reading/);
  });
});
