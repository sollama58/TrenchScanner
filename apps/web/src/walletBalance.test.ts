import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BurnBalance } from "./burn";
import { BALANCE_FRESH_MS, BALANCE_POLL_MS, BalanceStore, compactSol, compactTokens } from "./walletBalance";

const reading = (totalRaw: string): BurnBalance => ({
  mint: "m",
  decimals: 6,
  tokenProgram: "t",
  totalRaw,
  solLamports: "1000000000",
  accounts: [],
});

describe("BalanceStore", () => {
  let now = 1_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
  });
  afterEach(() => vi.useRealTimers());
  const store = (read: () => Promise<BurnBalance>) =>
    new BalanceStore(
      read,
      () => now,
      () => true,
    );

  it("shares one read between panels that open together", async () => {
    const read = vi.fn(() => Promise.resolve(reading("5")));
    const s = store(read);
    s.open();
    s.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(s.get().balance?.totalRaw).toBe("5");
  });

  it("reads again for a panel opening on an older reading, and polls once for all", async () => {
    const read = vi.fn(() => Promise.resolve(reading("5")));
    const s = store(read);
    s.open();
    await Promise.resolve();
    now += BALANCE_FRESH_MS;
    s.open();
    expect(read).toHaveBeenCalledTimes(2);
    now += BALANCE_POLL_MS;
    await vi.advanceTimersByTimeAsync(BALANCE_POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("keeps the last balances on a failed refresh, and forgets them once every panel closes", async () => {
    let fail = false;
    const s = store(() => (fail ? Promise.reject(new Error("down")) : Promise.resolve(reading("7"))));
    const close = s.open();
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    s.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.get()).toMatchObject({ balance: { totalRaw: "7" }, error: "down" });
    close();
    close();
    expect(s.get()).toEqual({ balance: null, error: null, at: null });
    await vi.advanceTimersByTimeAsync(BALANCE_POLL_MS * 2);
    expect(s.get().balance).toBeNull();
  });

  it("drops an answer that lands after the panels closed", async () => {
    let answer: (b: BurnBalance) => void = () => {};
    const s = store(() => new Promise((resolve) => (answer = resolve)));
    s.open()();
    answer(reading("9"));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.get().balance).toBeNull();
  });
});

describe("header amounts", () => {
  it("shortens SOL by size", () => {
    expect(compactSol("42000000")).toBe("0.042");
    expect(compactSol("12346000000")).toBe("12.35");
    expect(compactSol("250500000000")).toBe("250.5");
    expect(compactSol("0")).toBe("0");
  });
  it("shortens $ASDFASDFA with K, M and B", () => {
    expect(compactTokens("0", 6)).toBe("0");
    expect(compactTokens("950500000", 6)).toBe("951");
    expect(compactTokens("12400000000", 6)).toBe("12.4K");
    expect(compactTokens("1234567000000", 6)).toBe("1.23M");
    expect(compactTokens("4500000000000000", 6)).toBe("4.5B");
  });
});
