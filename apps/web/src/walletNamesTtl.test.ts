import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const asked: string[][] = [];
vi.mock("./api", () => ({
  ApiError: class extends Error {
    status = 0;
  },
  post: async (_path: string, body: { wallets: string[] }) => {
    asked.push(body.wallets);
    return { names: body.wallets[0] === "A" ? { A: { name: "Cupsey", source: "kol" } } : {} };
  },
}));

const { loadWalletNames, NAME_TTL_MS, NO_NAME_TTL_MS, resetWalletNames } = await import("./walletNames");

describe("wallet name answers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    asked.length = 0;
    resetWalletNames();
  });
  afterEach(() => vi.useRealTimers());

  it("asks again for a name after NAME_TTL_MS, and for a 'no name' after the shorter NO_NAME_TTL_MS", async () => {
    await loadWalletNames(["A"]);
    await loadWalletNames(["B"]);
    expect(asked).toEqual([["A"], ["B"]]);
    await loadWalletNames(["A", "B"]);
    expect(asked).toHaveLength(2);

    vi.advanceTimersByTime(NO_NAME_TTL_MS);
    await loadWalletNames(["A", "B"]);
    expect(asked[2]).toEqual(["B"]);

    vi.advanceTimersByTime(NAME_TTL_MS - NO_NAME_TTL_MS);
    await loadWalletNames(["A", "B"]);
    // A is due now; B, read again at NO_NAME_TTL_MS, is due once more as well.
    expect(asked[3]).toEqual(["A", "B"]);
  });
});
