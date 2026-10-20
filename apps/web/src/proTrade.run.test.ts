import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runTrade end to end, with the wallet, the API and two-factor stood in for.
const owner = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// A real Jupiter buy built by the API on mainnet (2026-10-18): 0.01 SOL on USDC, unsigned.
const fixture = readFileSync(new URL("./proTrade.fixture.b64.txt", import.meta.url), "utf8").trim();

const h = vi.hoisted(() => ({
  api: vi.fn(),
  post: vi.fn(),
  signTransaction: vi.fn(),
  walletName: "Phantom",
  now: 1_000_000,
}));

vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  api: h.api,
  post: h.post,
}));
vi.mock("./twoFactor", () => ({
  withTwoFactor: (call: (headers: Record<string, string>) => Promise<unknown>) => call({}),
}));
vi.mock("./burn", () => ({
  burnWallet: () => null,
  readyBurnWallet: async () => ({
    key: "w",
    name: h.walletName,
    wallet: {
      name: h.walletName,
      accounts: [{ address: owner }],
      features: { "solana:signTransaction": { signTransaction: h.signTransaction } },
    },
  }),
}));

const {
  runTrade,
  TradeError,
  privyUnreachable,
  BUILD_TIMEOUT_MS,
  SIGN_FRESH_MS,
  SLIPPAGE_LANDED,
  SLIPPAGE_UNSENT,
  STATUS_MAYBE,
  TRADING_OFF,
  resetTradeSessionForTests,
  walletTradeBlock,
  tradingUnavailable,
  onTradingSessionRefresh,
} = await import("./proTrade");
const { DEFAULT_TRADE_SETTINGS } = await import("./proTrade");
const { ApiError } = await import("./api");

const input = {
  owner,
  mint: USDC,
  side: "buy" as const,
  amount: 10_000_000n,
  settings: { ...DEFAULT_TRADE_SETTINGS, slippagePct: 50 },
};
const built = {
  transaction: fixture,
  lastValidBlockHeight: 1,
  route: "jupiter",
  quotedOut: "1",
  minOut: "1",
  tipLamports: "5000",
  priorityFeeLamports: "0",
};
/** A signed transaction whose signature is `n` repeated. */
const signed = (n: number) => Uint8Array.from([1, ...new Array<number>(64).fill(n), 0]);

beforeEach(() => {
  h.now = 1_000_000;
  h.walletName = "Phantom";
  resetTradeSessionForTests();
  vi.spyOn(Date, "now").mockImplementation(() => h.now);
  h.api.mockImplementation(async (path: string) =>
    path === "/pro/trade/build" ? built : { state: "confirmed" },
  );
  h.post.mockImplementation(async () => ({ signature: "sig" }));
});
afterEach(() => {
  vi.restoreAllMocks();
  h.api.mockReset();
  h.post.mockReset();
  h.signTransaction.mockReset();
});

describe("runTrade", () => {
  it("builds afresh and asks again when signing outlived the blockhash, and sends only the new one", async () => {
    let signs = 0;
    h.signTransaction.mockImplementation(async () => {
      signs++;
      // The first signature takes 41 s, the second a moment.
      h.now += signs === 1 ? SIGN_FRESH_MS + 1_000 : 2_000;
      return [{ signedTransaction: signed(signs) }];
    });
    let builds = 0;
    h.api.mockImplementation(async (path: string) =>
      path === "/pro/trade/build" ? { ...built, buildToken: `token-${++builds}` } : { state: "confirmed" },
    );
    const stages: string[] = [];
    await expect(
      runTrade(input, (s) => {
        stages.push(s);
      }),
    ).resolves.toBe("sig");
    // The fresh build's token goes with the fresh signature.
    expect((h.post.mock.calls[0]![1] as { buildToken?: string }).buildToken).toBe("token-2");
    expect(h.api.mock.calls.filter(([p]) => p === "/pro/trade/build")).toHaveLength(2);
    expect(stages.slice(0, 4)).toEqual(["building", "signing", "building", "signing"]);
    expect(h.post).toHaveBeenCalledTimes(1);
    const sent = Buffer.from((h.post.mock.calls[0]![1] as { transaction: string }).transaction, "base64");
    expect(sent[1]).toBe(2);
  });

  it("sends nothing when the second signature is slow too", async () => {
    h.signTransaction.mockImplementation(async () => {
      h.now += SIGN_FRESH_MS + 1_000;
      return [{ signedTransaction: signed(1) }];
    });
    const out = runTrade(input, () => {});
    await expect(out).rejects.toBeInstanceOf(TradeError);
    await expect(out).rejects.toThrow(/too long to sign/);
    expect(h.post).not.toHaveBeenCalled();
  });

  it("gives up on a build that hangs, with a time limit on it and none on the send", async () => {
    h.api.mockImplementation(async (_path: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(runTrade(input, () => {})).rejects.toThrow(
      /took too long to build the trade\. Nothing was sent/,
    );
    expect(BUILD_TIMEOUT_MS).toBe(45_000);
  });

  it("asks again after a status poll that timed out", async () => {
    h.signTransaction.mockImplementation(async () => [{ signedTransaction: signed(1) }]);
    let polls = 0;
    h.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/pro/trade/build") return built;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (++polls === 1) throw new DOMException("The operation timed out.", "TimeoutError");
      return { state: "confirmed" };
    });
    await expect(runTrade(input, () => {})).resolves.toBe("sig");
    expect(polls).toBe(2);
    // The send itself has no time limit: a send that times out may have gone out.
    expect(h.post.mock.calls[0]).toHaveLength(2);
  });

  it("reports a landed slippage miss as a miss, not a fill", async () => {
    h.signTransaction.mockImplementation(async () => [{ signedTransaction: signed(1) }]);
    h.api.mockImplementation(async (path: string) =>
      path === "/pro/trade/build"
        ? built
        : { state: "failed", reason: "slippage", error: '{"InstructionError":[2,{"Custom":6001}]}' },
    );
    const err = await runTrade(input, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TradeError);
    if (!(err instanceof TradeError)) return;
    expect(err.message).toBe(SLIPPAGE_LANDED);
    expect(err.signature).toBeTruthy();
    expect(err.message).not.toMatch(/Nothing was sent|timed out/);
  });

  it("keeps a dropped send that then lands as a fill, and one that reverts as slippage", async () => {
    h.signTransaction.mockImplementation(async () => [{ signedTransaction: signed(1) }]);
    h.post.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    h.api.mockImplementation(async (path: string) =>
      path === "/pro/trade/build" ? built : { state: "confirmed" },
    );
    await expect(runTrade(input, () => {})).resolves.toEqual(expect.any(String));
    // The pace is taken when the click is accepted, so the next trade waits out that second.
    h.now += 2_000;

    h.api.mockImplementation(async (path: string) =>
      path === "/pro/trade/build"
        ? built
        : { state: "failed", error: '{"InstructionError":[2,{"Custom":6001}]}' },
    );
    await expect(runTrade(input, () => {})).rejects.toThrow(SLIPPAGE_LANDED);
  });

  it("says a sender refusal sent nothing, even when the refusal names slippage", async () => {
    h.signTransaction.mockImplementation(async () => [{ signedTransaction: signed(1) }]);
    h.post.mockRejectedValue(
      new ApiError(409, `Helius Sender refused the trade: custom program error: 0x1771`, { notSent: true }),
    );
    await expect(runTrade(input, () => {})).rejects.toThrow(SLIPPAGE_UNSENT);
    h.post.mockRejectedValue(
      new ApiError(409, "Helius Sender refused the trade: HTTP 400", { notSent: true }),
    );
    await expect(runTrade(input, () => {})).rejects.toThrow(/Helius Sender refused the trade: HTTP 400/);
  });

  it("says an unanswered send that the chain never sees may still land, not that slippage missed", async () => {
    h.signTransaction.mockImplementation(async () => [{ signedTransaction: signed(1) }]);
    h.post.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    h.api.mockImplementation(async (path: string) => {
      if (path === "/pro/trade/build") return built;
      h.now += 30_000;
      return { state: "unknown" };
    });
    const err = await runTrade(input, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TradeError);
    if (!(err instanceof TradeError)) return;
    expect(err.message).toMatch(/Lost touch with the server while sending/);
    expect(err.message).not.toMatch(/slippage/);
    expect(err.signature).toBeTruthy();
  });

  it("will not start a second trade while the first is still signing", async () => {
    let release: (v: { signedTransaction: Uint8Array }[]) => void = () => {};
    h.signTransaction.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const first = runTrade(input, () => {});
    await vi.waitFor(() => expect(h.signTransaction).toHaveBeenCalled());
    await expect(runTrade(input, () => {})).rejects.toThrow(/already signing/);
    expect(walletTradeBlock(owner)).toMatch(/already signing/);
    release([{ signedTransaction: signed(1) }]);
    await expect(first).resolves.toBe("sig");
    expect(walletTradeBlock(owner)).toBeNull();
  });

  it("keeps the signature locked after the panel gives up, and drops it once the chain fails it", async () => {
    h.signTransaction.mockImplementation(async () => [{ signedTransaction: signed(1) }]);
    h.api.mockImplementation(async (path: string) => {
      if (path === "/pro/trade/build") return { ...built, blockhashAt: h.now };
      h.now += 100_000;
      return { state: "unknown" };
    });
    const err = await runTrade(input, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TradeError);
    if (!(err instanceof TradeError)) return;
    expect(err.signature).toBeTruthy();
    expect(err.message).toMatch(/Still waiting on the chain/);
    expect(walletTradeBlock(owner)).toMatch(/still in flight/);
    h.now += 2_000;
    h.api.mockImplementation(async (path: string) =>
      path === "/pro/trade/build" ? built : { state: "failed", error: "timed out" },
    );
    await expect(runTrade(input, () => {})).rejects.toThrow(/still in flight/);
  });

  it("does not open the wallet when the window closed before anything was sent", async () => {
    const signal = AbortSignal.abort();
    await expect(runTrade({ ...input, signal }, () => {})).rejects.toThrow(/window closed/);
    expect(h.signTransaction).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("does not sign a buy whose decimals are unknown", async () => {
    h.api.mockImplementation(async (path: string) =>
      path === "/pro/trade/build" ? { ...built, decimals: null } : { state: "confirmed" },
    );
    await expect(runTrade(input, () => {})).rejects.toThrow(/decimals aren't known/);
    expect(h.signTransaction).not.toHaveBeenCalled();
  });

  it("rebuilds before signing when the blockhash is already late", async () => {
    let builds = 0;
    h.api.mockImplementation(async (path: string) => {
      if (path !== "/pro/trade/build") return { state: "confirmed" };
      builds++;
      return {
        ...built,
        blockhashAt: builds === 1 ? h.now - SIGN_FRESH_MS - 1 : h.now,
        buildToken: `t-${builds}`,
      };
    });
    h.signTransaction.mockImplementation(async () => [{ signedTransaction: signed(1) }]);
    await expect(runTrade(input, () => {})).resolves.toBe("sig");
    expect(builds).toBe(2);
    expect(h.signTransaction).toHaveBeenCalledTimes(1);
    expect((h.post.mock.calls[0]![1] as { buildToken?: string }).buildToken).toBe("t-2");
  });

  it("waits for the quote stage to finish before opening the wallet", async () => {
    let quoteOnScreen = false;
    h.signTransaction.mockImplementation(async () => {
      expect(quoteOnScreen).toBe(true);
      return [{ signedTransaction: signed(1) }];
    });
    await expect(
      runTrade(input, async (stage) => {
        if (stage !== "signing") return;
        await new Promise((r) => setTimeout(r, 0));
        quoteOnScreen = true;
      }),
    ).resolves.toBe("sig");
  });

  it("says a status 404 after a send may still have landed, and keeps the lock", async () => {
    h.signTransaction.mockImplementation(async () => [{ signedTransaction: signed(1) }]);
    h.api.mockImplementation(async (path: string) => {
      if (path === "/pro/trade/build") return built;
      throw new ApiError(404, "not found", { error: "not found" });
    });
    let refreshed = 0;
    const stop = onTradingSessionRefresh(() => {
      refreshed++;
    });
    const err = await runTrade(input, () => {}).catch((e: unknown) => e);
    stop();
    expect(err).toBeInstanceOf(TradeError);
    if (!(err instanceof TradeError)) return;
    expect(err.message).toBe(STATUS_MAYBE);
    expect(err.signature).toBeTruthy();
    expect(err.message).not.toMatch(/Still waiting/);
    expect(walletTradeBlock(owner)).toMatch(/still in flight/);
    expect(refreshed).toBe(1);
  });

  it("refreshes the session when the build says trading is off, and signs nothing", async () => {
    h.api.mockImplementation(async () => {
      throw new ApiError(404, TRADING_OFF, { notSent: true });
    });
    let refreshed = 0;
    const stop = onTradingSessionRefresh(() => {
      refreshed++;
    });
    await expect(runTrade(input, () => {})).rejects.toThrow(TRADING_OFF);
    stop();
    expect(h.signTransaction).not.toHaveBeenCalled();
    expect(refreshed).toBe(1);
    expect(walletTradeBlock(owner)).toBeNull();
    expect(tradingUnavailable).toEqual(expect.any(Function));
  });

  it("says Privy is unreachable when Privy's signing can't reach Privy", async () => {
    h.walletName = "Privy";
    h.signTransaction.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(runTrade(input, () => {})).rejects.toThrow(/Privy is unreachable right now/);
    // Another wallet's network error is its own.
    h.walletName = "Phantom";
    await expect(runTrade(input, () => {})).rejects.toThrow("Failed to fetch");
  });
});

describe("privyUnreachable", () => {
  it("tells Privy being down from a cancel or a refusal", () => {
    expect(privyUnreachable(new TypeError("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(privyUnreachable(new Error("Request failed", { cause: new TypeError("Load failed") }))).toBe(true);
    expect(privyUnreachable(Object.assign(new Error("Service Unavailable"), { status: 503 }))).toBe(true);
    expect(privyUnreachable(new Error("User rejected the request"))).toBe(false);
    expect(privyUnreachable(new Error("cancelled"))).toBe(false);
    expect(privyUnreachable(null)).toBe(false);
  });
});
