import { describe, expect, it } from "vitest";
import * as core from "@trenchscanner/core/screenCuts";
import * as card from "./AlertCard";

/**
 * The alert card re-declares the safety screen's cuts to turn a tile red exactly when its reading
 * fails the screen. These tie each copy to core's (screenCuts.ts, taken from source under the
 * "trenchscanner-web" condition as chartMarks is), so a cut moved in core alone fails here instead
 * of the tiles quietly drawing the old line (audit 2026-10-14 L6, 2026-10-27 SW-7).
 */
describe("the alert card's safety-screen cuts", () => {
  it("match core's screenCuts.ts", () => {
    const names = [
      "SAFETY_MAX_FRESH_WALLET_PCT",
      "SAFETY_REJECT_EMPTY_WALLET_PCT",
      "SAFETY_REJECT_BLOCK_ZERO_HELD_PCT",
      "SAFETY_REJECT_TOP10_HOLDER_PCT",
      "SAFETY_MAX_LARGEST_HOLDER_PCT",
      "SAFETY_REJECT_LINKED_COUNT",
      "SAFETY_REJECT_CEX_FUNDED_COUNT",
      "SAFETY_COUNT_CUT_HOLDERS",
    ] as const;
    for (const name of names) expect({ name, value: card[name] }).toEqual({ name, value: core[name] });
  });

  it("scale count cuts to the holders read as core does", () => {
    for (const cut of [core.SAFETY_REJECT_LINKED_COUNT, core.SAFETY_REJECT_CEX_FUNDED_COUNT])
      for (const checked of [null, undefined, -1, 0, 1, 2, 10, 19, 24, 25, 26, 40])
        expect({ cut, checked, at: card.countCutFor(cut, checked) }).toEqual({
          cut,
          checked,
          at: core.countCutFor(cut, checked),
        });
  });
});
