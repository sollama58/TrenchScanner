import { beforeEach, describe, expect, it } from "vitest";

// A fake chrome.runtime that answers ping and connect for the IDs in `installed`, and a plain
// localStorage; neither exists under node.
const installed = new Set<string>();
const sent: { id: string; type: unknown }[] = [];
const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    sendMessage(id: string, message: { type?: unknown }, callback: (response: unknown) => void) {
      sent.push({ id, type: message.type });
      callback(installed.has(id) ? { ok: true, connected: false, version: "0.2.2" } : undefined);
    },
  },
};
const { findExtension, handOverKey } = await import("./extensionBridge");

const STORE_ZIP = "abcdefghijklmnopabcdefghijklmnop";

describe("finding the extension", () => {
  it("knows the Chrome Web Store build without a link", async () => {
    installed.add("pjacklmgcelhgfjnkbdpkhcbjcblijca");
    expect((await findExtension(null))?.id).toBe("pjacklmgcelhgfjnkbdpkhcbjcblijca");
    installed.clear();
    store.clear();
  });

  beforeEach(() => {
    installed.clear();
    sent.length = 0;
    store.clear();
  });

  it("finds a build whose ID only the extension's link carries", async () => {
    installed.add(STORE_ZIP);
    expect(await findExtension(null)).toBeNull();
    expect((await findExtension(STORE_ZIP))?.id).toBe(STORE_ZIP);
  });

  it("remembers that ID, so Settings opened without the link (after signing in again) finds it", async () => {
    installed.add(STORE_ZIP);
    await findExtension(STORE_ZIP);
    sent.length = 0;
    expect((await findExtension(null))?.id).toBe(STORE_ZIP);
    expect(sent[0]).toEqual({ id: STORE_ZIP, type: "ping" });
    expect((await handOverKey(STORE_ZIP, "tsx_x", null)).ok).toBe(true);
  });

  it("doesn't remember an ID that didn't answer, and refuses to hand a key to an unknown one", async () => {
    expect(await findExtension(STORE_ZIP)).toBeNull();
    expect(store.size).toBe(0);
    expect(await handOverKey(STORE_ZIP, "tsx_x", null)).toEqual({ ok: false, error: "Unknown extension." });
  });
});
