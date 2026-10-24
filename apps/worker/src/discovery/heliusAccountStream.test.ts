// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it, vi } from "vitest";
import { keysOf } from "@trenchscanner/core";
import {
  HeliusAccountStream,
  REFUSED_FIRST_RETRY_MS,
  REFUSED_RETRY_MS,
  refusedRetryMs,
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

  it("keeps the accounts both lists follow covered when a live key's accounts change", () => {
    const { stream, socket } = started();
    stream.watch("mint-1", ["acc-a", "acc-b"], 1_000);
    const first = subscribes(socket)[0]!.id;
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: first, result: 20 }), 2_000);
    // One holder swapped: the old subscription stays live until the new one is confirmed.
    stream.watch("mint-1", ["acc-a", "acc-c"], 5_000);
    const second = subscribes(socket)[1]!.id;
    expect(socket.sent.some((m) => m.method === "transactionUnsubscribe")).toBe(false);
    expect(stream.coveredSince("mint-1", "acc-a")).toBe(2_000);
    expect(stream.coveredSince("mint-1", "acc-c")).toBeNull();
    expect(stream.coveredSince("mint-1", "acc-b")).toBeNull();
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: second, result: 21 }), 6_000);
    expect(socket.sent.at(-1)).toMatchObject({ method: "transactionUnsubscribe", params: [20] });
    // acc-a keeps its cover from the first subscription; acc-c starts with the new one.
    expect(stream.coveredSince("mint-1", "acc-a")).toBe(2_000);
    expect(stream.coveredSince("mint-1", "acc-c")).toBe(6_000);
    // A second change carries acc-a's cover on again.
    stream.watch("mint-1", ["acc-a", "acc-d"], 7_000);
    const third = subscribes(socket)[2]!.id;
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: third, result: 22 }), 8_000);
    expect(stream.coveredSince("mint-1", "acc-a")).toBe(2_000);
    // A dropped connection ends every cover, carried ones included.
    stream.checkIdle(Date.now() + 10 * 60_000);
    expect(stream.coveredSince("mint-1", "acc-a")).toBeNull();
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

  it("asks for a refused subscription again soon, waiting longer after each refusal, and counts them", () => {
    const { stream, socket } = started();
    stream.watch("mint-1", ["acc-a"], 1_000);
    const id = subscribes(socket)[0]!.id;
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, error: { message: "nope" } }), 2_000);
    // 10 s after the first refusal (it used to wait the full REFUSED_RETRY_MS: a called coin
    // turned away once had its first five minutes polled, with no 1-second bars).
    stream.watch("mint-1", ["acc-a"], 2_000 + REFUSED_FIRST_RETRY_MS - 1);
    expect(subscribes(socket)).toHaveLength(1);
    stream.watch("mint-1", ["acc-a"], 2_000 + REFUSED_FIRST_RETRY_MS);
    expect(subscribes(socket)).toHaveLength(2);
    // Refused again: twice as long this time.
    const second = subscribes(socket)[1]!.id;
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: second, error: { message: "nope" } }), 13_000);
    stream.watch("mint-1", ["acc-a"], 13_000 + refusedRetryMs(2) - 1);
    expect(subscribes(socket)).toHaveLength(2);
    stream.watch("mint-1", ["acc-a"], 13_000 + refusedRetryMs(2));
    expect(subscribes(socket)).toHaveLength(3);
    const again = subscribes(socket)[2]!.id;
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: again, result: 5 }), 400_000);
    expect(stream.coveredSince("mint-1", "acc-a", 400_000)).toBe(400_000);
    // Confirmed: not asked for again.
    stream.watch("mint-1", ["acc-a"], 2_000_000);
    expect(subscribes(socket)).toHaveLength(3);
    expect(stream.takeStats()).toMatchObject({ refused: 2, capped: 0 });
    stream.stop();
  });

  it("waits 10 s, then doubling, never longer than REFUSED_RETRY_MS", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(refusedRetryMs)).toEqual([
      10_000,
      20_000,
      40_000,
      80_000,
      160_000,
      REFUSED_RETRY_MS,
      REFUSED_RETRY_MS,
    ]);
  });

  it("at the cap, gives a key nobody asked for in 5 minutes' place to a new one, else counts it turned away", () => {
    const { stream, socket } = started();
    for (let i = 0; i < 200; i += 1) stream.watch(`mint-${i}`, [`acc-${i}`], i === 0 ? 0 : 290_000);
    expect(subscribes(socket)).toHaveLength(200);
    // mint-0 was last asked for 5 minutes ago: it makes room.
    stream.watch("new-1", ["acc-new-1"], 300_000);
    expect(subscribes(socket)).toHaveLength(201);
    // The rest were asked for 10 s ago: the next is turned away, and counted.
    stream.watch("new-2", ["acc-new-2"], 300_000);
    expect(subscribes(socket)).toHaveLength(201);
    expect(stream.takeStats()).toMatchObject({ capped: 1 });
    stream.stop();
  });

  it("follows as many tx keys as maxTxKeys allows", () => {
    const { stream, socket } = started();
    stream.maxTxKeys(400);
    for (let i = 0; i < 400; i += 1) stream.watch(`mint-${i}`, [`acc-${i}`], 290_000);
    expect(subscribes(socket)).toHaveLength(400);
    stream.watch("new-1", ["acc-new-1"], 300_000);
    expect(subscribes(socket)).toHaveLength(400);
    expect(stream.takeStats()).toMatchObject({ capped: 1 });
    stream.stop();
  });

  it("says an account's cover is on its way only while Helius has yet to answer its subscribe", () => {
    const { stream, socket } = started();
    stream.watch("mint-1", ["acc-a"], 1_000);
    expect(stream.awaitingCover("mint-1", "acc-a", 1_000)).toBe(true);
    expect(stream.awaitingCover("mint-1", "acc-z", 1_000)).toBe(false);
    expect(stream.awaitingCover("mint-2", "acc-a", 1_000)).toBe(false);
    const id = subscribes(socket)[0]!.id;
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, result: 9 }), 2_000);
    // Confirmed: coveredSince answers from here.
    expect(stream.awaitingCover("mint-1", "acc-a", 2_000)).toBe(false);
    expect(stream.coveredSince("mint-1", "acc-a", 2_000)).toBe(2_000);

    // Refused: no cover is coming.
    stream.watch("mint-3", ["acc-c"], 3_000);
    const refused = subscribes(socket)[1]!.id;
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: refused, error: { message: "nope" } }), 3_000);
    expect(stream.awaitingCover("mint-3", "acc-c", 3_000)).toBe(false);

    // Turned away at the cap: no cover is coming either.
    stream.maxTxKeys(2);
    stream.watch("mint-4", ["acc-d"], 4_000);
    expect(stream.awaitingCover("mint-4", "acc-d", 4_000)).toBe(false);

    // Asked for while the socket is down: not on its way until a connection sends it.
    stream.watch("mint-1", ["acc-a", "acc-b"], 5_000);
    socket.close();
    expect(stream.awaitingCover("mint-1", "acc-b", 5_000)).toBe(false);
    stream.stop();
  });
});
