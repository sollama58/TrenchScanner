import { describe, expect, it, vi } from "vitest";
import { PricePathBook } from "@trenchscanner/core";
import { PricePathSeeder } from "./pricePathSeed.js";

const NOW = new Date("2026-10-13T01:00:00Z").getTime();
const MIN = 60_000;

describe("PricePathSeeder", () => {
  it("refills each candidate's tape once from its stored scan ticks", async () => {
    const book = new PricePathBook();
    const load = vi.fn(async (tokenIds: string[], since: Date) => {
      expect(since.getTime()).toBe(NOW - 65 * MIN);
      return tokenIds.flatMap((tokenId) =>
        Array.from({ length: 31 }, (_, i) => ({
          tokenId,
          takenAt: new Date(NOW - (30 - i) * MIN),
          priceUsd: 1 + i * 0.01,
          holderCount: 100 + i,
          holderCountAt: null,
        })),
      );
    });
    const seeder = new PricePathSeeder(book, load, NOW);
    seeder.seed(
      [
        { mint: "a", tokenId: "ta" },
        { mint: "b", tokenId: undefined },
      ],
      NOW,
    );
    await seeder.settled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]![0]).toEqual(["ta"]);
    book.observe("a", new Date(NOW + 0.5 * MIN), 1.3);
    expect(book.features("a").pathRet30mPct!).toBeCloseTo(30, 6);
    expect(book.features("b").pathRet5mPct).toBeNull();

    // Asked for once: the next cycle's candidates don't query it again.
    seeder.seed([{ mint: "a", tokenId: "ta" }], NOW + 0.5 * MIN);
    await seeder.settled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("stops once the process is older than the tape, and survives a failed read", async () => {
    const book = new PricePathBook();
    const load = vi.fn(async () => {
      throw new Error("db down");
    });
    const seeder = new PricePathSeeder(book, load, NOW);
    seeder.seed([{ mint: "a", tokenId: "ta" }], NOW);
    await seeder.settled();
    expect(load).toHaveBeenCalledTimes(1);
    seeder.seed([{ mint: "b", tokenId: "tb" }], NOW + 66 * MIN);
    await seeder.settled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(book.size).toBe(0);
  });
});
