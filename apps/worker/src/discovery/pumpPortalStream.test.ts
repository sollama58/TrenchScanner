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
