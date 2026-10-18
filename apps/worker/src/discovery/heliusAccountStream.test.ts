// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it, vi } from "vitest";
import { keysOf } from "@trenchscanner/core";
import {
  HeliusAccountStream,
  STREAM_SETTLE_MS,
  streamCredits,
  streamTx,
  UNWATCHED_TTL_MS,
} from "./heliusAccountStream.js";

/** A socket that records what was sent and is open from the start. */
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

function started(onTx = vi.fn()) {
  const stream = new HeliusAccountStream(
    "wss://example",
    onTx,
    FakeSocket as unknown as new (url: string) => WebSocket,
  );
  stream.start();
  const socket = FakeSocket.last!;
  socket.open();
  return { stream, socket, onTx };
}

const subscribes = (socket: FakeSocket) => socket.sent.filter((m) => m.method === "transactionSubscribe");

describe("HeliusAccountStream", () => {
  it("follows an account key with accountSubscribe and hands over each update", () => {
    const onAccount = vi.fn();
    const stream = new HeliusAccountStream(
      "wss://example",
      vi.fn(),
      FakeSocket as unknown as new (url: string) => WebSocket,
      onAccount,
    );
    stream.start();
    const socket = FakeSocket.last!;
    socket.open();
    stream.watch("curve:m", ["curve-acc"], 1_000, "account");
    const sub = socket.sent.find((m) => m.method === "accountSubscribe")!;
    expect(sub.params).toEqual(["curve-acc", { commitment: "confirmed", encoding: "base64" }]);
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: sub.id, result: 5 }), 2_000);
    expect(stream.coveredSince("curve:m", "curve-acc")).toBe(2_000);
    const note = JSON.stringify({
      jsonrpc: "2.0",
      method: "accountNotification",
      params: { subscription: 5, result: { context: { slot: 1 }, value: { data: ["AAAA", "base64"] } } },
    });
    stream.handleMessage(note);
    expect(onAccount).toHaveBeenCalledWith("curve:m", "AAAA", note.length, 1);
    expect(stream.takeStats()).toMatchObject({
      accountSubscriptions: 1,
      subscriptions: 0,
      accountUpdates: 1,
    });
    stream.unwatch("curve:m");
    expect(socket.sent.at(-1)).toMatchObject({ method: "accountUnsubscribe", params: [5] });
    expect(stream.coveredSince("curve:m", "curve-acc")).toBeNull();
    stream.stop();
  });

  it("subscribes a key's accounts and covers them once Helius answers", () => {
    const { stream, socket } = started();
    stream.watch("mint-1", ["acc-a", "acc-b"], 1_000);
    const [sub] = subscribes(socket);
    expect((sub!.params as unknown[])[0]).toMatchObject({ accountInclude: ["acc-a", "acc-b"], vote: false });
    expect(stream.coveredSince("mint-1", "acc-a")).toBeNull();
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: sub!.id, result: 77 }), 2_000);
    expect(stream.coveredSince("mint-1", "acc-a")).toBe(2_000);
    expect(stream.coveredSince("mint-1", "acc-z")).toBeNull();
    // Asked again with the same accounts: nothing new is sent.
    stream.watch("mint-1", ["acc-b", "acc-a"], 3_000);
    expect(subscribes(socket)).toHaveLength(1);
    stream.stop();
  });

  it("hands each delivered transaction to its key, and counts what it received", () => {
    const { stream, socket, onTx } = started();
    stream.watch("mint-1", ["acc-a"]);
    const id = subscribes(socket)[0]!.id;
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, result: 5 }));
    const note = JSON.stringify({
      jsonrpc: "2.0",
      method: "transactionNotification",
      params: {
        subscription: 5,
        result: { signature: "sig-1", slot: 1, transaction: { meta: { err: null } } },
      },
    });
    stream.handleMessage(note);
    // A notification for a subscription it doesn't hold is ignored.
    stream.handleMessage(note.replace('"subscription":5', '"subscription":6'));
    expect(onTx).toHaveBeenCalledTimes(1);
    expect(onTx).toHaveBeenCalledWith("mint-1", "sig-1", { meta: { err: null } });
    const stats = stream.takeStats();
    expect(stats.txs).toBe(1);
    expect(stats.connected).toBe(1);
    expect(stats.bytes).toBeGreaterThan(note.length * 2);
    expect(stream.takeStats().bytes).toBe(0);
    stream.stop();
  });

  it("replaces a key's subscription when its accounts change, undoing one still unanswered", () => {
    const { stream, socket } = started();
    stream.watch("mint-1", ["acc-a"]);
    const first = subscribes(socket)[0]!.id;
    stream.watch("mint-1", ["acc-a", "acc-b"]);
    const second = subscribes(socket)[1]!.id;
    // The first subscribe's answer comes late: it is unsubscribed, and covers nothing.
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: first, result: 10 }), 1_000);
    expect(socket.sent.at(-1)).toMatchObject({ method: "transactionUnsubscribe", params: [10] });
    expect(stream.coveredSince("mint-1", "acc-b")).toBeNull();
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: second, result: 11 }), 2_000);
    expect(stream.coveredSince("mint-1", "acc-b")).toBe(2_000);
    stream.stop();
  });

  it("drops keys nobody asked for lately, and all cover when the connection goes quiet", () => {
    const { stream, socket } = started();
    stream.watch("old", ["acc-a"], 0);
    stream.watch("new", ["acc-b"], UNWATCHED_TTL_MS);
    const [a, b] = subscribes(socket);
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: a!.id, result: 1 }));
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: b!.id, result: 2 }));
    stream.evict(UNWATCHED_TTL_MS + 1);
    expect(socket.sent.at(-1)).toMatchObject({ method: "transactionUnsubscribe", params: [1] });
    expect(stream.coveredSince("old", "acc-a")).toBeNull();
    expect(stream.coveredSince("new", "acc-b")).not.toBeNull();
    stream.checkIdle(Date.now() + 10 * 60_000);
    expect(stream.coveredSince("new", "acc-b")).toBeNull();
    stream.stop();
  });

  it("prices streamed bytes at 2 credits per 0.1 MB", () => {
    expect(streamCredits(1_000_000)).toBe(20);
    expect(STREAM_SETTLE_MS).toBeGreaterThan(0);
  });

  it('reads the account keys of an "accounts"-detail transaction, which sit outside `message`', () => {
    const tx = streamTx({
      transaction: {
        signatures: ["sig"],
        accountKeys: [{ pubkey: "wallet", signer: true }, { pubkey: "acc-a" }],
      },
      meta: { err: null },
    })!;
    expect(keysOf(tx)).toEqual(["wallet", "acc-a"]);
    // A full-detail transaction is left as it is.
    const full = { transaction: { message: { accountKeys: ["x"] } }, meta: null };
    expect(streamTx(full)).toBe(full);
    expect(streamTx(null)).toBeNull();
  });

  it("does not resend a refused subscription every time it is asked for", () => {
    const { stream, socket } = started();
    stream.watch("mint-1", ["acc-a"]);
    const id = subscribes(socket)[0]!.id;
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "nope" } }));
    stream.watch("mint-1", ["acc-a"]);
    expect(subscribes(socket)).toHaveLength(1);
    expect(stream.coveredSince("mint-1", "acc-a")).toBeNull();
    stream.watch("mint-1", ["acc-a", "acc-b"]);
    expect(subscribes(socket)).toHaveLength(2);
    stream.stop();
  });
});
