import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUsageMeter, clearHeliusCreditsOut, heliusCreditsOut, meteredFetch } from "../apiUsage.js";
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

describe("HeliusAccountStream metering", () => {
  it("counts a metered socket's bytes and connections as Helius credits in API usage", () => {
    apiUsageMeter.take();
    const stream = new HeliusAccountStream(
      "wss://example",
      vi.fn(),
      FakeSocket as unknown as new (url: string) => WebSocket,
    ).metered("stream/test");
    stream.start();
    FakeSocket.last!.open(); // 1 credit
    // 120 KB: 2.4 credits, 2 whole now and 0.4 carried.
    for (let i = 0; i < 12; i += 1) stream.handleMessage("x".repeat(10_000));
    const rows = apiUsageMeter.take().filter((r) => r.feature === "stream/test");
    expect(rows.every((r) => r.provider === "helius" && r.endpoint === "websocket")).toBe(true);
    expect(rows.reduce((n, r) => n + r.counter.credits, 0)).toBe(3);
    expect(rows.reduce((n, r) => n + r.counter.calls, 0)).toBe(12);
    stream.stop();
  });
});

describe("HeliusAccountStream stalls and resubscribes (the chart's live tail)", () => {
  function confirmed(
    stream: HeliusAccountStream,
    socket: FakeSocket,
    key: string,
    subId: number,
    at: number,
  ) {
    stream.watch(key, [`${key}-acc`], at, "account");
    const sub = socket.sent.filter((m) => m.method === "accountSubscribe").at(-1)!;
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: sub.id, result: subId }), at);
  }

  it("covers nothing while the socket is silent past stallAfter, though the reconnect waits longer", () => {
    const stream = new HeliusAccountStream(
      "wss://example",
      vi.fn(),
      FakeSocket as unknown as new (url: string) => WebSocket,
      vi.fn(),
    ).stallAfter(20_000);
    stream.start();
    const socket = FakeSocket.last!;
    socket.open();
    confirmed(stream, socket, "chart:m", 4, 1_000);
    const t0 = Date.now();
    expect(stream.coveredSince("chart:m", "chart:m-acc", t0 + 5_000)).toBe(1_000);
    expect(stream.stalledForMs(t0 + 5_000)).toBe(0);
    expect(stream.coveredSince("chart:m", "chart:m-acc", t0 + 25_000)).toBeNull();
    expect(stream.stalledForMs(t0 + 25_000)).toBeGreaterThanOrEqual(25_000);
    // Not replaced yet: the reconnect keeps its own minute.
    stream.checkIdle(t0 + 25_000);
    expect(stream.takeStats()).toMatchObject({ stalls: 0, reconnects: 0, connected: 1 });
    stream.checkIdle(t0 + 61_000);
    expect(stream.takeStats()).toMatchObject({ stalls: 1, reconnects: 1, connected: 0 });
    stream.stop();
  });

  it("never stalls without stallAfter (the worker's sockets)", () => {
    const { stream, socket } = started();
    confirmed(stream, socket, "curve:m", 4, 1_000);
    expect(stream.coveredSince("curve:m", "curve:m-acc", Date.now() + 50_000)).toBe(1_000);
    expect(stream.stalledForMs(Date.now() + 50_000)).toBe(0);
    stream.stop();
  });

  it("resubscribes a key: its cover starts over once Helius confirms the new subscription", () => {
    const { stream, socket } = started();
    confirmed(stream, socket, "chart:m", 4, 1_000);
    stream.resubscribe("chart:m");
    expect(socket.sent.at(-2)).toMatchObject({ method: "accountUnsubscribe", params: [4] });
    const again = socket.sent.at(-1)!;
    expect(again).toMatchObject({ method: "accountSubscribe", params: ["chart:m-acc", expect.anything()] });
    expect(stream.coveredSince("chart:m", "chart:m-acc")).toBeNull();
    stream.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: again.id, result: 8 }), 9_000);
    expect(stream.coveredSince("chart:m", "chart:m-acc")).toBe(9_000);
    // An unknown key is a no-op.
    stream.resubscribe("nope");
    stream.stop();
  });
});

/** Trips this process's credits-out stand-down the way Helius does, with a 200 batch answer. */
async function creditsRunOut() {
  const f = meteredFetch(
    (async () =>
      new Response('[{"jsonrpc":"2.0","id":"0","error":{"code":-32429,"message":"max usage reached"}}]', {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  );
  await f("https://mainnet.helius-rpc.com/?api-key=k", {
    method: "POST",
    body: JSON.stringify([{ jsonrpc: "2.0", id: "0", method: "getBalance", params: [] }]),
  });
  expect(heliusCreditsOut()).not.toBeNull();
}

describe("HeliusAccountStream while Helius's credits are out", () => {
  afterEach(() => {
    clearHeliusCreditsOut();
    vi.useRealTimers();
  });

  it("doesn't connect until the stand-down is over", async () => {
    vi.useFakeTimers();
    await creditsRunOut();
    FakeSocket.last = null;
    const stream = new HeliusAccountStream(
      "wss://example",
      vi.fn(),
      FakeSocket as unknown as new (url: string) => WebSocket,
    );
    stream.start();
    expect(FakeSocket.last).toBeNull();
    clearHeliusCreditsOut();
    vi.advanceTimersByTime(15 * 60_000 + 6_000);
    expect(FakeSocket.last).not.toBeNull();
    stream.stop();
  });

  it("doesn't subscribe on an open socket meanwhile, and asks again later", async () => {
    const { stream, socket } = started();
    await creditsRunOut();
    stream.watch("logs:a", ["A"], Date.now(), "logs");
    expect(socket.sent.filter((m) => m.method === "logsSubscribe")).toHaveLength(0);
    clearHeliusCreditsOut();
    stream.watch("logs:a", ["A"], Date.now() + 5 * 60_000, "logs");
    expect(socket.sent.filter((m) => m.method === "logsSubscribe")).toHaveLength(1);
    stream.stop();
  });
});

describe("HeliusAccountStream slot times", () => {
  const slotNote = (slot: number) =>
    JSON.stringify({
      jsonrpc: "2.0",
      method: "slotNotification",
      params: { subscription: 0, result: { slot, parent: slot - 1, root: slot - 32 } },
    });

  it("remembers when the slot feed first announced each slot", () => {
    const { stream } = started();
    stream.handleMessage(slotNote(100), 5_000);
    stream.handleMessage(slotNote(100), 5_900);
    stream.handleMessage(slotNote(101), 5_400);
    expect(stream.slotTime(100)).toBe(5_000);
    expect(stream.slotTime(101)).toBe(5_400);
    expect(stream.slotTime(99)).toBeNull();
    expect(stream.slotTime(null)).toBeNull();
    stream.stop();
  });

  it("forgets the oldest slots past the ones it keeps", () => {
    const { stream } = started();
    for (let s = 0; s < 2_000; s++) stream.handleMessage(slotNote(s), s);
    expect(stream.slotTime(0)).toBeNull();
    expect(stream.slotTime(1_999)).toBe(1_999);
    stream.stop();
  });
});
