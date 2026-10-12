// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { HttpError } from "@trenchscanner/core";
import { FRESH_QUOTE_BUDGET_MS, readFreshQuotes } from "./scanJob.js";

// Jupiter rate-limiting us, failing or slow must never cost a decision: the cycle goes on without
// a quote, and the row anchors on DexScreener's price (decisionAnchor, rule 3).
describe("readFreshQuotes", () => {
  it("gives no quotes, without throwing, when Jupiter fails or isn't configured", async () => {
    const failing = {
      getFreshQuotes: async () => {
        throw new HttpError(429, "https://api.jup.ag/tokens/v2/search", "rate limited");
      },
    };
    expect((await readFreshQuotes(failing, ["a"])).size).toBe(0);
    expect((await readFreshQuotes(undefined, ["a"])).size).toBe(0);
    expect((await readFreshQuotes({}, ["a"])).size).toBe(0);
  });

  it("asks within the cycle's budget", async () => {
    let asked: number | undefined;
    await readFreshQuotes(
      {
        getFreshQuotes: async (_mints, opts) => {
          asked = opts?.deadlineMs;
          return new Map();
        },
      },
      ["a"],
    );
    expect(asked).toBe(FRESH_QUOTE_BUDGET_MS);
  });
});
