import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const asked: string[][] = [];
const identities: (boolean | undefined)[] = [];
/** Wallets starting with Q come back unread the first time, as a queued read does; Z every time until `zRead`. */
const answered = new Set<string>();
let zRead = false;
vi.mock("./api", () => ({
  ApiError: class extends Error {
    status = 0;
  },
  post: async (_path: string, body: { wallets: string[]; identity?: boolean }) => {
    asked.push(body.wallets);
    identities.push(body.identity);
    const unread = body.wallets.filter(
      (w) => (w.startsWith("Q") && !answered.has(w)) || (w.startsWith("Z") && !zRead),
    );
    for (const w of body.wallets) if (w.startsWith("Q")) answered.add(w);
    const names: Record<string, unknown> =
      body.wallets[0] === "A" ? { A: { name: "Cupsey", source: "kol" } } : {};
    if (zRead)
      for (const w of body.wallets) if (w.startsWith("Z")) names[w] = { name: "Late", source: "kol" };
    return { names, unread };
  },
}));

const {
  loadWalletNames,
  NAME_TTL_MS,
  NO_NAME_TTL_MS,
  resetWalletNames,
  UNREAD_COOLDOWN_MS,
  UNREAD_RETRY_MS,
} = await import("./walletNames");

describe("wallet name answers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    asked.length = 0;
    identities.length = 0;
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

  it("starts asking again after a rest once the retries run out, so a name still loads", async () => {
    zRead = false;
    await loadWalletNames(["Z1"]);
    // Three retries a minute or so apart, each unread.
    for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(UNREAD_RETRY_MS);
    expect(asked).toHaveLength(4);
    // Then nothing for a while...
    await vi.advanceTimersByTimeAsync(UNREAD_RETRY_MS * 2);
    expect(asked).toHaveLength(4);
    // ...until the rest is over, when the count starts over and it is asked again.
    zRead = true;
    await vi.advanceTimersByTimeAsync(UNREAD_COOLDOWN_MS);
    expect(asked).toHaveLength(5);
    expect(asked[4]).toEqual(["Z1"]);
    // Read now: no more asking.
    await vi.advanceTimersByTimeAsync(UNREAD_COOLDOWN_MS * 2);
    expect(asked).toHaveLength(5);
  });

  it("reads TrenchScanner's own names alone when asked, and Helius's later for a list that wants them", async () => {
    await loadWalletNames(["B"], false);
    expect(identities).toEqual([false]);
    // Its own "no name" stands for another own read...
    await loadWalletNames(["B"], false);
    expect(asked).toHaveLength(1);
    // ...but a list reading Helius's names asks again.
    await loadWalletNames(["B"]);
    expect(asked).toEqual([["B"], ["B"]]);
    expect(identities[1]).toBeUndefined();
    // A name found either way stands for both.
    await loadWalletNames(["A"], false);
    await loadWalletNames(["A"]);
    expect(asked).toHaveLength(3);
  });
});
