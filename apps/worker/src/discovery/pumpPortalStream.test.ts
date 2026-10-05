import { describe, expect, it, vi } from "vitest";
import { parsePumpPortalMessage, PumpPortalStream } from "./pumpPortalStream.js";

const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";

describe("parsePumpPortalMessage", () => {
  it("reads launches and graduations", () => {
    expect(
      parsePumpPortalMessage(JSON.stringify({ mint: MINT, txType: "create", symbol: "DOG" })),
    ).toMatchObject({
      kind: "create",
      mintAddress: MINT,
      symbol: "DOG",
    });
    expect(parsePumpPortalMessage(JSON.stringify({ mint: MINT, txType: "migrate" }))?.kind).toBe("migrate");
  });

  it("ignores subscription acks, trades, malformed JSON and bad addresses", () => {
    expect(parsePumpPortalMessage(JSON.stringify({ message: "Successfully subscribed" }))).toBeNull();
    expect(parsePumpPortalMessage(JSON.stringify({ mint: MINT, txType: "buy" }))).toBeNull();
    expect(parsePumpPortalMessage("{not json")).toBeNull();
    expect(parsePumpPortalMessage(JSON.stringify({ mint: "not-a-mint", txType: "create" }))).toBeNull();
  });
});

describe("PumpPortalStream buffer", () => {
  it("drains each mint once, keeping a graduation over a launch", () => {
    const stream = new PumpPortalStream("wss://example.invalid", null);
    stream.handleMessage(JSON.stringify({ mint: MINT, txType: "migrate" }));
    stream.handleMessage(JSON.stringify({ mint: MINT, txType: "create" }));
    const events = stream.drain();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("migrate");
    expect(stream.drain()).toEqual([]);
  });

  it("is a no-op without a WebSocket implementation", () => {
    const stream = new PumpPortalStream("wss://example.invalid", null);
    expect(() => stream.start()).not.toThrow();
    stream.stop();
  });
});

describe("PumpPortalStream trade flow", () => {
  const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

  function fakeSocket() {
    const sent: unknown[] = [];
    return { sent, socket: { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) } };
  }

  it("follows a launch's trades into the flow book and subscribes it", () => {
    const stream = new PumpPortalStream("wss://example.invalid", null);
    const at = Date.now();
    stream.handleMessage(
      JSON.stringify({
        mint: MINT,
        txType: "create",
        traderPublicKey: "dev",
        solAmount: 1.2,
        initialBuy: 4e7,
      }),
      at,
    );
    stream.handleMessage(
      JSON.stringify({
        mint: MINT,
        txType: "buy",
        traderPublicKey: "sniper",
        solAmount: 1,
        tokenAmount: 3e7,
      }),
      at + 1000,
    );
    expect(stream.drain().map((e) => e.kind)).toEqual(["create"]);
    const flow = stream.tradeFlow(MINT)!;
    expect(flow.devInitialBuySol).toBe(1.2);
    expect(flow.earlyBuyerCount).toBe(1);

    const { sent, socket } = fakeSocket();
    (stream as unknown as { socket: unknown }).socket = socket;
    stream.watch([OTHER]);
    stream.flushSubscriptions();
    expect(sent).toEqual([{ method: "subscribeTokenTrade", keys: [MINT, OTHER] }]);
    stream.flushSubscriptions();
    expect(sent).toHaveLength(1);

    // Connected, a launch's trades are subscribed at once - its first seconds are the snipers.
    const LATER = "So11111111111111111111111111111111111111112";
    stream.handleMessage(JSON.stringify({ mint: LATER, txType: "create", traderPublicKey: "dev2" }), at);
    expect(sent[1]).toEqual({ method: "subscribeTokenTrade", keys: [LATER] });
  });

  it("reports only launch inputs, and stops subscribing, once PumpPortal refuses trades", () => {
    const stream = new PumpPortalStream("wss://example.invalid", null);
    const { sent, socket } = fakeSocket();
    (stream as unknown as { socket: unknown }).socket = socket;
    const at = Date.now() - 6 * 60_000;
    stream.handleMessage(
      JSON.stringify({
        mint: MINT,
        txType: "create",
        traderPublicKey: "dev",
        solAmount: 1.2,
        initialBuy: 4e7,
      }),
      at,
    );
    expect(sent).toEqual([{ method: "subscribeTokenTrade", keys: [MINT] }]);
    // Before any trade has arrived, a launch watched with no trades is not "zero buyers": the
    // connection may not be sending trades at all, so the counters stay unknown.
    expect(stream.tradeFlow(MINT)!.uniqueBuyers5m).toBeNull();
    expect(stream.tradeFlow(MINT)!.devInitialBuySol).toBe(1.2);

    stream.handleMessage(
      JSON.stringify({
        message:
          "'subscribeTokenTrade' and 'subscribeAccountTrade' methods are only available when connecting with an API key funded with at least 0.02 SOL.",
      }),
    );
    expect(stream.tradeFlowRefused).toBe(true);
    const flow = stream.tradeFlow(MINT)!;
    expect(flow.devInitialBuySol).toBe(1.2);
    expect(flow.uniqueBuyers5m).toBeNull();
    expect(flow.tradesPerMin5m).toBeNull();
    expect(flow.earlyBuyerCount).toBeNull();

    stream.watch([OTHER]);
    stream.flushSubscriptions();
    stream.handleMessage(JSON.stringify({ mint: OTHER, txType: "create", traderPublicKey: "dev2" }), at);
    expect(sent).toHaveLength(1);
    // The subscription ack is not a refusal.
    stream.handleMessage(JSON.stringify({ message: "Successfully subscribed to token creation events." }));
    expect(stream.drain().map((e) => e.mintAddress)).toEqual([MINT, OTHER]);

    // A reconnect gets one more round of subscriptions (the key may have been funded since) but
    // the refusal stands until a trade actually arrives - the book's empty windows are not
    // reported as zero buyers in between.
    // (What the open handler does: every tracked mint back on the list, one retry allowed.)
    (stream as unknown as { retrySubscriptionsOnce: boolean }).retrySubscriptionsOnce = true;
    for (const mint of stream.book!.trackedMints()) {
      (stream as unknown as { pendingSubscribe: Set<string> }).pendingSubscribe.add(mint);
    }
    stream.flushSubscriptions();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ method: "subscribeTokenTrade", keys: [MINT, OTHER] });
    expect(stream.tradeFlowRefused).toBe(true);
    expect(stream.tradeFlow(MINT)!.uniqueBuyers5m).toBeNull();
    // A second flush without trades sends nothing more.
    stream.watch([MINT]);
    stream.flushSubscriptions();
    expect(sent).toHaveLength(2);
    // A delivered trade is the confirmation: the counters come back.
    stream.handleMessage(
      JSON.stringify({ mint: MINT, txType: "buy", traderPublicKey: "w1", solAmount: 1, tokenAmount: 3e7 }),
      at + 1000,
    );
    expect(stream.tradeFlowRefused).toBe(false);
    expect(stream.tradeFlow(MINT)!.uniqueBuyers5m).toBe(0);
    expect(stream.tradeFlow(MINT)!.earlyBuyerCount).toBe(1);
  });

  it("ignores trades for mints it isn't following, and stays out of the book when flow is off", () => {
    const stream = new PumpPortalStream("wss://example.invalid", null);
    stream.handleMessage(JSON.stringify({ mint: MINT, txType: "buy", traderPublicKey: "w", solAmount: 1 }));
    expect(stream.book?.has(MINT)).toBe(false);
    const off = new PumpPortalStream("wss://example.invalid", null, { tradeFlow: false });
    off.handleMessage(JSON.stringify({ mint: MINT, txType: "create", traderPublicKey: "dev" }));
    expect(off.tradeFlow(MINT)).toBeUndefined();
    expect(off.drain()).toHaveLength(1);
  });
});

describe("PumpPortalStream idle watchdog", () => {
  /** A WebSocket stand-in that never opens, never sends and never closes - a half-open socket. */
  class SilentSocket extends EventTarget {
    static made = 0;
    readyState = 0;
    closed = false;
    constructor() {
      super();
      SilentSocket.made += 1;
    }
    send() {}
    close() {
      this.closed = true;
    }
  }

  it("replaces a connection that has gone silent, once, and ignores its late close", async () => {
    vi.useFakeTimers();
    try {
      SilentSocket.made = 0;
      const stream = new PumpPortalStream(
        "wss://example.invalid",
        SilentSocket as unknown as new (url: string) => WebSocket,
        { tradeFlow: false },
      );
      stream.start();
      expect(SilentSocket.made).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(SilentSocket.made).toBe(1);
      // Past the idle timeout, then the reconnect backoff.
      await vi.advanceTimersByTimeAsync(45_000 + 2_000);
      expect(SilentSocket.made).toBe(2);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
