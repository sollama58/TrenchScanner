import { describe, expect, it } from "vitest";
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
