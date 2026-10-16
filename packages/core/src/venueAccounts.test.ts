import { describe, expect, it } from "vitest";
import { venueAccountsOf } from "./venueAccounts.js";

describe("venueAccountsOf", () => {
  it("derives a Pump.fun coin's bonding curve and PumpSwap pool, as they are on chain", () => {
    // 2bQcQ...pump, 2026-10-16: RugCheck listed the pool and not the curve, which held 22%.
    const venues = venueAccountsOf("2bQcQFdqp62Wo99noGRYdWdLrCZ3SAVXtjTP2jUspump");
    expect(venues.has("7oq2c9s7GD1RAxFRccybGc4kZDMzwHSLBaKrEbXA9mJG")).toBe(true);
    expect(venues.has("3fZsfqSQuMGvD4aR1YQhQrewSnkYfmxm4R6wFnv69mkE")).toBe(true);
  });

  it("derives the AMMs' shared vault authorities, as they are on chain", () => {
    const venues = venueAccountsOf("2bQcQFdqp62Wo99noGRYdWdLrCZ3SAVXtjTP2jUspump");
    for (const authority of [
      "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh", // Raydium LaunchLab
      "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL", // Raydium CPMM
      "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM v4
      "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC", // Meteora DAMM v2
      "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", // Meteora DBC
    ]) {
      expect(venues.has(authority)).toBe(true);
    }
  });

  it("keeps the shared authorities for a string that is not a mint", () => {
    const venues = venueAccountsOf("not-a-mint");
    expect(venues.size).toBe(5);
  });
});
