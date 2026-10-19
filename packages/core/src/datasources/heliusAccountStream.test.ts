import { describe, expect, it, vi } from "vitest";
import { HeliusAccountStream } from "./heliusAccountStream.js";

/*
 * The "logs" kind (the API's live trades). The "tx" and "account" kinds are covered by the worker's
 * apps/worker/src/discovery/heliusAccountStream.test.ts, which runs this same class.
 */

/** A socket that records what was sent. */
class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    for (const fn of this.listeners.get("open") ?? []) fn({});
  }
}

function started() {
  const onLogs = vi.fn();
  const onAccount = vi.fn();
  const stream = new HeliusAccountStream(
    "wss://example",
    vi.fn(),
    FakeSocket as unknown as new (url: string) => WebSocket,
    onAccount,
    onLogs,
  );
  stream.start();
  const socket = FakeSocket.last!;
  socket.open();
  return { stream, socket, onLogs, onAccount };
}

const logsNote = (subscription: number, signature: string, err: unknown = null) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      subscription,
      result: { context: { slot: 42 }, value: { signature, err, logs: ["Program data: AAAA"] } },
    },
  });

describe("HeliusAccountStream logs keys", () => {
  it("follows a logs key with logsSubscribe and hands over each successful transaction's logs", () => {
    const { stream, socket, onLogs } = started();
    stream.watch("trades-curve:m", ["curve-acc"], 1_000, "logs");
    const sub = socket.sent.find((m) => m.method === "logsSubscribe")!;
    expect(sub.params).toEqual([{ mentions: ["curve-acc"] }, { commitment: "confirmed" }]);
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: sub.id, result: 9 }), 2_000);
    expect(stream.coveredSince("trades-curve:m", "curve-acc")).toBe(2_000);

    const ok = logsNote(9, "sig-1");
    stream.handleMessage(ok);
    expect(onLogs).toHaveBeenCalledWith("trades-curve:m", "sig-1", ["Program data: AAAA"], ok.length, 42);
    // A failed transaction is counted but not handed over.
    stream.handleMessage(logsNote(9, "sig-2", { InstructionError: [0, "Custom"] }));
    // Another subscription's, or a malformed one: ignored.
    stream.handleMessage(logsNote(10, "sig-3"));
    stream.handleMessage(JSON.stringify({ method: "logsNotification", params: { subscription: 9 } }));
    expect(onLogs).toHaveBeenCalledTimes(1);
    expect(stream.takeStats()).toMatchObject({
      logsSubscriptions: 1,
      logsUpdates: 2,
      accountSubscriptions: 0,
      subscriptions: 0,
    });

    stream.unwatch("trades-curve:m");
    expect(socket.sent.at(-1)).toMatchObject({ method: "logsUnsubscribe", params: [9] });
    stream.stop();
  });

  it("takes one account per logs key and caps how many are followed", () => {
    const { stream, socket } = started();
    stream.watch("two", ["a", "b"], 1_000, "logs");
    expect(socket.sent.filter((m) => m.method === "logsSubscribe")).toHaveLength(0);
    for (let i = 0; i < 120; i += 1) stream.watch(`k${i}`, [`acc${i}`], 1_000, "logs");
    expect(socket.sent.filter((m) => m.method === "logsSubscribe")).toHaveLength(100);
    // The other kinds have their own caps.
    stream.watch("curve:x", ["curve-x"], 1_000, "account");
    expect(socket.sent.filter((m) => m.method === "accountSubscribe")).toHaveLength(1);
    stream.stop();
  });

  it("undoes a logs subscribe dropped before Helius answered it with logsUnsubscribe", () => {
    const { stream, socket } = started();
    stream.watch("k", ["acc"], 1_000, "logs");
    const sub = socket.sent.find((m) => m.method === "logsSubscribe")!;
    stream.unwatch("k");
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: sub.id, result: 3 }));
    expect(socket.sent.at(-1)).toMatchObject({ method: "logsUnsubscribe", params: [3] });
    stream.stop();
  });

  it("leaves account updates to onAccount", () => {
    const { stream, socket, onLogs, onAccount } = started();
    stream.watch("curve:m", ["curve-acc"], 1_000, "account");
    const sub = socket.sent.find((m) => m.method === "accountSubscribe")!;
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: sub.id, result: 5 }));
    stream.handleMessage(
      JSON.stringify({
        method: "accountNotification",
        params: { subscription: 5, result: { context: { slot: 1 }, value: { data: ["AAAA", "base64"] } } },
      }),
    );
    expect(onAccount).toHaveBeenCalledTimes(1);
    expect(onLogs).not.toHaveBeenCalled();
    stream.stop();
  });
});
