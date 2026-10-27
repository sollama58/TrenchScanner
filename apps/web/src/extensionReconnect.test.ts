import { beforeEach, describe, expect, it, vi } from "vitest";

// The dev build's ID (extensionBridge.ts), answering like the extension's service worker.
const DEV_ID = "jhdfdijmhnomcdijohdfibelodhfiigl";
// An extension a crafted ?ext= link named, answering as if its key were refused for this account.
const OTHER_ID = "abcdefghijklmnopabcdefghijklmnop";
let ping: Record<string, unknown> | undefined;
let otherPinged = false;
let takes = true;
const handed: string[] = [];
const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    sendMessage(id: string, message: { type?: string; key?: string }, callback: (r: unknown) => void) {
      if (id === OTHER_ID) {
        otherPinged = true;
        if (message.type === "ping")
          return callback({ ok: true, connected: false, version: "0.9.0", refusedAccount: "7xQ1…k2Ab" });
        handed.push(`other:${message.key ?? ""}`);
        return callback({ ok: true });
      }
      if (id !== DEV_ID) return callback(undefined);
      if (message.type === "ping") return callback(ping);
      handed.push(message.key ?? "");
      callback({ ok: takes });
    },
  },
};
const { reconnectExtension } = await import("./extensionReconnect");

const WALLET = "7xQ1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaak2Ab";
const created = {
  id: "k1",
  prefix: "tsx_abc",
  createdAt: "2026-10-24T00:00:00Z",
  lastUsedAt: null,
  secret: "tsx_new",
};

describe("reconnecting the extension after signing in again", () => {
  const create = vi.fn(async () => created);
  const revoke = vi.fn(async () => undefined);
  beforeEach(() => {
    handed.length = 0;
    takes = true;
    create.mockClear();
    revoke.mockClear();
  });

  it("hands a new key to an extension whose key was refused for this account", async () => {
    ping = { ok: true, connected: false, version: "0.2.2", refusedAccount: "7xQ1…k2Ab" };
    expect(await reconnectExtension(WALLET, { create, revoke })).toBe(true);
    expect(handed).toEqual(["tsx_new"]);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("leaves another account's extension alone", async () => {
    ping = { ok: true, connected: false, version: "0.2.2", refusedAccount: "9zzz…zzzz" };
    expect(await reconnectExtension(WALLET, { create, revoke })).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("leaves one the reader disconnected, or one still connected, alone", async () => {
    ping = { ok: true, connected: false, version: "0.2.2", refusedAccount: null };
    expect(await reconnectExtension(WALLET, { create, revoke })).toBe(false);
    ping = { ok: true, connected: true, version: "0.2.2", refusedAccount: null };
    expect(await reconnectExtension(WALLET, { create, revoke })).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("revokes the key when the extension doesn't take it", async () => {
    ping = { ok: true, connected: false, version: "0.2.2", refusedAccount: "7xQ1…k2Ab" };
    takes = false;
    expect(await reconnectExtension(WALLET, { create, revoke })).toBe(false);
    expect(revoke).toHaveBeenCalledWith("k1");
  });

  it("never hands a key to a remembered ID outside the known builds (audit EX-3)", async () => {
    store.set("trench.extensionId", OTHER_ID);
    otherPinged = false;
    ping = undefined;
    expect(await reconnectExtension(WALLET, { create, revoke })).toBe(false);
    expect(otherPinged).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(handed).toEqual([]);
    store.clear();
  });
});
