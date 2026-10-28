import { describe, expect, it } from "vitest";
import { ModelAlertHub, type ModelAlertClient } from "./modelAlertHub.js";
import type { LoadedModelAlert } from "./modelAlertPayload.js";

interface FakeSocket {
  readyState: number;
  sent: string[];
  closed: number;
  listeners: {
    close: Array<() => void>;
    error: Array<() => void>;
    message: Array<() => void>;
    pong: Array<() => void>;
  };
  pings: number;
  terminated: boolean;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close" | "error" | "pong", listener: () => void): void;
  ping(): void;
  terminate(): void;
}

function socket(): FakeSocket {
  const listeners = {
    close: [] as Array<() => void>,
    error: [] as Array<() => void>,
    message: [] as Array<() => void>,
    pong: [] as Array<() => void>,
  };
  const ws: FakeSocket = {
    readyState: 1,
    sent: [],
    closed: 0,
    pings: 0,
    terminated: false,
    listeners,
    ping() {
      this.pings += 1;
    },
    terminate() {
      this.terminated = true;
      this.readyState = 3;
      for (const listener of listeners.close) listener();
    },
    send(data) {
      this.sent.push(data);
    },
    close(code = 1000) {
      this.readyState = 3;
      this.closed = code;
      for (const listener of listeners.close) listener();
    },
    on(event, listener) {
      listeners[event].push(listener);
    },
  };
  return ws;
}

function client(partial: Partial<ModelAlertClient> & Pick<ModelAlertClient, "keyId">): ModelAlertClient {
  return {
    userId: partial.userId ?? "user-1",
    keyId: partial.keyId,
    walletAddress: partial.walletAddress ?? "wallet-1",
    openedAt: partial.openedAt ?? 1_000,
  };
}

function stream() {
  let listener: ((id: string) => void) | null = null;
  return {
    onCuratedAlertId(fn: (id: string) => void) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    emit(id: string) {
      listener?.(id);
    },
  };
}

const message = { kind: "curated" as const, id: "alert-1", mint: "mint" };

describe("model alert hub", () => {
  it("refuses a socket past the per-key and per-user caps", () => {
    const ids = stream();
    const hub = new ModelAlertHub(
      ids,
      async () => null,
      async () => true,
      async (keys) => new Set(keys),
    );
    const first = socket();
    const second = socket();
    const third = socket();
    expect(hub.connect(first, client({ keyId: "k1" }))).toBe("ok");
    expect(hub.connect(second, client({ keyId: "k1" }))).toBe("ok");
    expect(hub.connect(third, client({ keyId: "k1" }))).toBe("key_cap");
    expect(third.closed).toBe(0);

    const other = socket();
    expect(hub.connect(other, client({ keyId: "k2", userId: "user-2", walletAddress: "wallet-2" }))).toBe(
      "ok",
    );
    const fourth = socket();
    const fifth = socket();
    expect(hub.connect(fourth, client({ keyId: "k3" }))).toBe("ok");
    expect(hub.connect(fifth, client({ keyId: "k3" }))).toBe("ok");
    const sixth = socket();
    expect(hub.connect(sixth, client({ keyId: "k4" }))).toBe("user_cap");
    hub.stop();
  });

  it("closes a socket when its key is revoked and does not send that alert", async () => {
    const ids = stream();
    const live = new Set(["k1"]);
    const hub = new ModelAlertHub(
      ids,
      async () => ({ alertedAt: new Date(2_000), message: message as LoadedModelAlert["message"] }),
      async () => true,
      async () => live,
    );
    const ws = socket();
    expect(hub.connect(ws, client({ keyId: "k1" }))).toBe("ok");
    hub.disconnectKey("k1");
    expect(ws.closed).toBe(4401);
    ids.emit("alert-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.sent).toEqual([]);
    hub.stop();
  });

  it("does not send an alert from before the socket authenticated", async () => {
    const ids = stream();
    const hub = new ModelAlertHub(
      ids,
      async () => ({ alertedAt: new Date(500), message: message as LoadedModelAlert["message"] }),
      async () => true,
      async (keys) => new Set(keys),
    );
    const ws = socket();
    hub.connect(ws, client({ keyId: "k1", openedAt: 1_000 }));
    ids.emit("old");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.sent).toEqual([]);
    expect(ws.closed).toBe(0);
    hub.stop();
  });

  it("closes on the next alert when the subscription has lapsed, and sends nothing", async () => {
    const ids = stream();
    const hub = new ModelAlertHub(
      ids,
      async () => ({ alertedAt: new Date(2_000), message: message as LoadedModelAlert["message"] }),
      async () => false,
      async (keys) => new Set(keys),
    );
    const ws = socket();
    hub.connect(ws, client({ keyId: "k1" }));
    ids.emit("alert-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.closed).toBe(4403);
    expect(ws.sent).toEqual([]);
    hub.stop();
  });

  it("pings each socket and drops one that stops answering (audit 10-27 WB-23)", async () => {
    const ids = stream();
    const hub = new ModelAlertHub(
      ids,
      async () => null,
      async () => true,
      async (keys) => new Set(keys),
      { pingMs: 10, recheckMs: 60_000 },
    );
    const answers = socket();
    const silent = socket();
    hub.connect(answers, client({ keyId: "k1" }));
    hub.connect(silent, client({ keyId: "k2", userId: "user-2" }));
    answers.ping = function () {
      this.pings += 1;
      for (const listener of this.listeners.pong) listener();
    };
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(answers.pings).toBeGreaterThanOrEqual(3);
    expect(answers.terminated).toBe(false);
    expect(silent.pings).toBe(1);
    expect(silent.terminated).toBe(true);
    hub.stop();
  });

  it("still sends to recently checked sockets when the key read fails, and not to stale ones", async () => {
    const ids = stream();
    let now = 100_000;
    let fail = false;
    const hub = new ModelAlertHub(
      ids,
      async () => ({ alertedAt: new Date(2_000), message: message as LoadedModelAlert["message"] }),
      async () => true,
      async (keys) => {
        if (fail) throw new Error("db down");
        return new Set(keys);
      },
      { now: () => now },
    );
    const ws = socket();
    hub.connect(ws, client({ keyId: "k1" }));
    fail = true;
    ids.emit("alert-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Checked at connect, a moment ago: one failed read no longer drops the alert.
    expect(ws.sent).toHaveLength(1);
    expect(ws.closed).toBe(0);
    // Past the grace with no passing check since: a failed read sends nothing.
    now += 120_000;
    ids.emit("alert-2");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.sent).toHaveLength(1);
    expect(ws.closed).toBe(0);
    hub.stop();
  });

  it("still sends to recently checked sockets when the access read fails", async () => {
    const ids = stream();
    const hub = new ModelAlertHub(
      ids,
      async () => ({ alertedAt: new Date(2_000), message: message as LoadedModelAlert["message"] }),
      async () => {
        throw new Error("access read failed");
      },
      async (keys) => new Set(keys),
    );
    const ws = socket();
    hub.connect(ws, client({ keyId: "k1" }));
    ids.emit("alert-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.sent).toHaveLength(1);
    expect(ws.closed).toBe(0);
    hub.stop();
  });
});
