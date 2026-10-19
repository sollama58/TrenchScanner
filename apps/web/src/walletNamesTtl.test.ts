import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const asked: string[][] = [];
/** Wallets starting with Q come back unread the first time, as a queued read does. */
const answered = new Set<string>();
vi.mock("./api", () => ({
  ApiError: class extends Error {
    status = 0;
  },
  post: async (_path: string, body: { wallets: string[] }) => {
    asked.push(body.wallets);
    const unread = body.wallets.filter((w) => w.startsWith("Q") && !answered.has(w));
    for (const w of body.wallets) if (w.startsWith("Q")) answered.add(w);
    return { names: body.wallets[0] === "A" ? { A: { name: "Cupsey", source: "kol" } } : {}, unread };
  },
}));

const { loadWalletNames, NAME_TTL_MS, NO_NAME_TTL_MS, resetWalletNames, UNREAD_RETRY_MS } =
  await import("./walletNames");

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

  it("asks again for a wallet the API left unread, without the list opening again", async () => {
    await loadWalletNames(["Q1", "C"]);
    expect(asked).toEqual([["Q1", "C"]]);
    await vi.advanceTimersByTimeAsync(UNREAD_RETRY_MS);
    expect(asked[1]).toEqual(["Q1"]);
    await vi.advanceTimersByTimeAsync(UNREAD_RETRY_MS * 2);
    expect(asked).toHaveLength(2);
  });
});
