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

  it("reads Pump.fun's Mayhem flag on a launch only, and only as a boolean", () => {
    const parse = (extra: object) => parsePumpPortalMessage(JSON.stringify({ mint: MINT, ...extra }));
    expect(parse({ txType: "create", is_mayhem_mode: true })?.isMayhemMode).toBe(true);
    expect(parse({ txType: "create", is_mayhem_mode: false })?.isMayhemMode).toBe(false);
    expect(parse({ txType: "create", is_mayhem_mode: "true" })?.isMayhemMode).toBeUndefined();
    expect(parse({ txType: "create" })?.isMayhemMode).toBeUndefined();
    expect(parse({ txType: "migrate", is_mayhem_mode: true })?.isMayhemMode).toBeUndefined();
  });

  it("names the launchpad PumpPortal says the coin came from", () => {
    expect(
      parsePumpPortalMessage(JSON.stringify({ mint: MINT, txType: "create", pool: "pump" }))?.launchpad,
    ).toBe("pumpfun");
    expect(
      parsePumpPortalMessage(JSON.stringify({ mint: MINT, txType: "create" }))?.launchpad,
    ).toBeUndefined();
  });

  it("keeps a launch's creator, the create transaction's signer", () => {
    const dev = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
    expect(
      parsePumpPortalMessage(JSON.stringify({ mint: MINT, txType: "create", traderPublicKey: dev }))?.creator,
    ).toBe(dev);
    expect(
      parsePumpPortalMessage(JSON.stringify({ mint: MINT, txType: "migrate", traderPublicKey: dev }))
        ?.creator,
    ).toBeUndefined();
    expect(
      parsePumpPortalMessage(JSON.stringify({ mint: MINT, txType: "create", traderPublicKey: "dev" }))
        ?.creator,
    ).toBeUndefined();
  });

  it("keeps a launch's metadata URI", () => {
    const uri = "https://ipfs.io/ipfs/bafkreibuifrxzohrvlpgdztmwku4o7wggni72irolspurpn3toi5mfjq2q";
    expect(parsePumpPortalMessage(JSON.stringify({ mint: MINT, txType: "create", uri }))?.metadataUri).toBe(
      uri,
    );
    expect(
      parsePumpPortalMessage(JSON.stringify({ mint: MINT, txType: "migrate", uri }))?.metadataUri,
    ).toBeUndefined();
  });

  it("carries a trade's signature and venue into the flow book's page", () => {
    const stream = new PumpPortalStream("ws://x", null);
    stream.handleMessage(
      JSON.stringify({ mint: MINT, txType: "create", traderPublicKey: MINT, pool: "pump" }),
      1000,
    );
    expect(stream.recentTrades(MINT)).toBeNull();
    stream.handleMessage(
      JSON.stringify({
        mint: MINT,
        txType: "buy",
        traderPublicKey: MINT,
        solAmount: 1.5,
        tokenAmount: 2_000,
        pool: "pump",
        signature: "sig-1",
      }),
      2000,
    );
    expect(stream.recentTrades(MINT)).toMatchObject({
      complete: true,
      bonding: true,
      trades: [{ wallet: MINT, side: "buy", sol: 1.5, tokens: 2_000, atMs: 2000, tx: "sig-1" }],
    });
    stream.handleMessage(JSON.stringify({ mint: MINT, txType: "migrate" }), 3000);
    expect(stream.recentTrades(MINT)!.bonding).toBe(false);
  });

  it("ignores subscription acks, trades, malformed JSON and bad addresses", () => {
    expect(parsePumpPortalMessage(JSON.stringify({ message: "Successfully subscribed" }))).toBeNull();
    expect(parsePumpPortalMessage(JSON.stringify({ mint: MINT, txType: "buy" }))).toBeNull();
    expect(parsePumpPortalMessage("{not json")).toBeNull();
    expect(parsePumpPortalMessage(JSON.stringify({ mint: "not-a-mint", txType: "create" }))).toBeNull();
  });
});

describe("PumpPortalStream buffer", () => {
  it("keeps a launch's relayed Mayhem flag after the buffer drains, first answer kept", () => {
    const stream = new PumpPortalStream("wss://example.invalid", null);
    const OTHER = "9GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
    stream.handleMessage(JSON.stringify({ mint: MINT, txType: "create", is_mayhem_mode: true }));
    stream.handleMessage(JSON.stringify({ mint: MINT, txType: "create", is_mayhem_mode: false }));
    stream.handleMessage(JSON.stringify({ mint: OTHER, txType: "create" }));
    stream.drain();
    expect(stream.relayedMayhem(MINT)).toBe(true);
    expect(stream.relayedMayhem(OTHER)).toBeUndefined();
  });

  it("drains each mint once, keeping a graduation over a launch", () => {
    const stream = new PumpPortalStream("wss://example.invalid", null);
    stream.handleMessage(JSON.stringify({ mint: MINT, txType: "migrate" }));
    stream.handleMessage(JSON.stringify({ mint: MINT, txType: "create" }));
    const events = stream.drain();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("migrate");
    expect(stream.drain()).toEqual([]);
  });

  it("lists the launches since the last drain, newest first, without draining them", () => {
    const OTHER = "9GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
    const GRADUATED = "8GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
    const stream = new PumpPortalStream("wss://example.invalid", null);
    stream.handleMessage(JSON.stringify({ mint: MINT, txType: "create" }));
    stream.handleMessage(JSON.stringify({ mint: GRADUATED, txType: "migrate" }));
    stream.handleMessage(JSON.stringify({ mint: OTHER, txType: "create" }));
    expect(stream.pendingLaunches()).toEqual([OTHER, MINT]);
    expect(stream.drain()).toHaveLength(3);
    expect(stream.pendingLaunches()).toEqual([]);
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

describe("PumpPortalStream health (audit 2026-11-28, FD-5)", () => {
  const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  /** A WebSocket stand-in the test opens, feeds and closes by hand. */
  class HandSocket extends EventTarget {
    static last: HandSocket | null = null;
    constructor() {
      super();
      HandSocket.last = this;
    }
    send() {}
    close() {}
    opened() {
      this.dispatchEvent(new Event("open"));
    }
    message(data: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
    }
    dropped() {
      this.dispatchEvent(new Event("close"));
    }
  }

  it("says how long since a launch, with no trade time on a stream that sends launches only", async () => {
    vi.useFakeTimers();
    try {
      const stream = new PumpPortalStream(
        "wss://example.invalid",
        HandSocket as unknown as new (url: string) => WebSocket,
      );
      stream.start();
      expect(stream.health()).toMatchObject({ connected: 0, connects: 0, launchAgeSec: 0 });
      const socket = HandSocket.last!;
      socket.opened();
      socket.message({ mint: MINT, txType: "create", traderPublicKey: MINT, pool: "pump" });
      await vi.advanceTimersByTimeAsync(40_000);
      // Launches arrive, trades never do: connected, a launch 40 s ago, and no trade time at all.
      const launchesOnly = stream.health();
      expect(launchesOnly).toMatchObject({ connected: 1, connects: 1, launchAgeSec: 40, tradesRefused: 0 });
      expect(launchesOnly).not.toHaveProperty("tradeAgeSec");
      // Only numbers: /health/worker drops anything else.
      expect(Object.values(launchesOnly).every((v) => typeof v === "number")).toBe(true);

      socket.message({
        mint: MINT,
        txType: "buy",
        traderPublicKey: MINT,
        solAmount: 1,
        tokenAmount: 10,
        pool: "pump",
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(stream.health()).toMatchObject({ launchAgeSec: 60, tradeAgeSec: 20 });

      // The connection drops and the launches stop: the age keeps counting, disconnected.
      socket.dropped();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stream.health()).toMatchObject({ connected: 0, launchAgeSec: 61 });
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a quiet start from start(), so a stream that never connects reads as old", async () => {
    vi.useFakeTimers();
    try {
      const stream = new PumpPortalStream(
        "wss://example.invalid",
        HandSocket as unknown as new (url: string) => WebSocket,
        { tradeFlow: false },
      );
      stream.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(stream.health()).toMatchObject({ connected: 0, launchAgeSec: 30 });
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
