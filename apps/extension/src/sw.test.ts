import { beforeEach, describe, expect, it, vi } from "vitest";
import { token } from "./shared/testToken";
import type { OverlayToken } from "./shared/types";

// The service worker's message gates and its alert checks (audit EX-11), against a fake `chrome`
// that records what the worker registers and does. The API is mocked: nothing leaves the test.

const EXT_ID = "jhdfdijmhnomcdijohdfibelodhfiigl";
const EXT_URL = `chrome-extension://${EXT_ID}/`;
const KEY = `tsx_${"a".repeat(43)}`;
const A = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
const B = "So11111111111111111111111111111111111111112";

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  reply: (r: unknown) => void,
) => unknown;
let onMessage: Listener;
let onMessageExternal: Listener;
let onAlarm: (alarm: { name: string }) => void;
const local = new Map<string, unknown>();
const notices: { id: string; title: string; message: string }[] = [];

function area(map: Map<string, unknown>) {
  return {
    async get(keys: string | string[]) {
      const list = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => map.has(k)).map((k) => [k, structuredClone(map.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) map.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of typeof keys === "string" ? [keys] : keys) map.delete(k);
    },
  };
}

(globalThis as { __STORE__?: boolean }).__STORE__ = false;
(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    id: EXT_ID,
    getURL: (path: string) => `${EXT_URL}${path}`,
    getManifest: () => ({ version: "0.9.1" }),
    sendMessage: () => Promise.resolve(),
    onMessage: { addListener: (l: Listener) => (onMessage = l) },
    onMessageExternal: { addListener: (l: Listener) => (onMessageExternal = l) },
  },
  storage: { local: area(local), session: area(new Map()) },
  action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
  alarms: { create: () => undefined, onAlarm: { addListener: (l: typeof onAlarm) => (onAlarm = l) } },
  notifications: {
    create: (id: string, o: { title: string; message: string }) =>
      void notices.push({ id, title: o.title, message: o.message }),
    clear: () => undefined,
    onClicked: { addListener: () => undefined },
  },
  sidePanel: { setPanelBehavior: async () => undefined, open: async () => undefined },
  tabs: { create: async () => undefined, sendMessage: async () => undefined },
};

const api = vi.hoisted(() => ({
  me: vi.fn(),
  feed: vi.fn(),
  site: vi.fn(),
  saveLook: vi.fn(async () => ({ ok: true })),
  saveSettings: vi.fn(),
  bubble: vi.fn(),
  safety: vi.fn(),
  token: vi.fn(),
  stats: vi.fn(),
  buddy: vi.fn(),
}));
vi.mock("./shared/api", async (original) => ({
  ...(await original<typeof import("./shared/api")>()),
  api,
}));
await import("./sw");

const panel = { id: EXT_ID, url: `${EXT_URL}panel.html` } as chrome.runtime.MessageSender;
const ringPage = {
  id: EXT_ID,
  url: "https://axiom.trade/pulse",
  tab: { id: 7, url: "https://axiom.trade/pulse" },
} as chrome.runtime.MessageSender;
const mapFrame = {
  id: EXT_ID,
  url: `${EXT_URL}map.html`,
  frameId: 3,
  tab: { id: 7, url: "https://axiom.trade/meme/x" },
} as chrome.runtime.MessageSender;

/** What the listener answered: `undefined` when it declined the message (returned false). */
async function send(listener: Listener, message: unknown, sender: chrome.runtime.MessageSender) {
  let reply: (r: unknown) => void = () => undefined;
  const answered = new Promise<unknown>((resolve) => (reply = resolve));
  const kept = listener(message, sender, reply);
  if (kept !== true) return Promise.race([answered, Promise.resolve(undefined)]);
  return answered;
}

function setStore(on: boolean) {
  (globalThis as { __STORE__?: boolean }).__STORE__ = on;
}

const call = (mcapUsd: number, peakMcapUsd: number | null = null, ageMs = 60_000) => ({
  model: "m1",
  name: "Model One",
  tier: "high",
  confidence: 70,
  calibratedPct: 22,
  at: new Date(Date.now() - ageMs).toISOString(),
  mcapUsd,
  peakMcapUsd,
});

beforeEach(() => {
  setStore(false);
  local.clear();
  notices.length = 0;
  for (const f of Object.values(api)) f.mockReset();
  api.saveLook.mockResolvedValue({ ok: true });
  api.me.mockResolvedValue({ wallet: "7xQ1…k2Ab", settings: {}, look: null });
});

describe("who the service worker answers", () => {
  it("ignores another extension's messages", async () => {
    local.set("key", KEY);
    expect(await send(onMessage, { type: "status" }, { ...panel, id: "other" })).toBeUndefined();
  });

  it("answers the panel", async () => {
    local.set("key", KEY);
    expect(await send(onMessage, { type: "status" }, panel)).toMatchObject({ connected: true });
  });

  it("answers a ring page only from its own list, never the panel's requests", async () => {
    local.set("key", KEY);
    expect(await send(onMessage, { type: "disconnect" }, ringPage)).toBeNull();
    expect(local.get("key")).toBe(KEY);
    expect(await send(onMessage, { type: "settings" }, ringPage)).toMatchObject({ rings: expect.anything() });
  });

  it("answers no ring page in the store build", async () => {
    setStore(true);
    local.set("key", KEY);
    expect(await send(onMessage, { type: "settings" }, ringPage)).toBeUndefined();
  });

  it("answers a page that isn't the extension's or a ring site with nothing", async () => {
    local.set("key", KEY);
    const page = { id: EXT_ID, url: "https://evil.example/", tab: { id: 9 } } as chrome.runtime.MessageSender;
    expect(await send(onMessage, { type: "disconnect" }, page)).toBeUndefined();
    expect(local.get("key")).toBe(KEY);
  });

  it("lets the map tab's frame make map reads only, while the map tab is on", async () => {
    local.set("key", KEY);
    api.site.mockResolvedValue({ status: 200, body: "{}" });
    expect(await send(onMessage, { type: "disconnect" }, mapFrame)).toBeUndefined();
    expect(local.get("key")).toBe(KEY);
    const read = { type: "site", method: "GET", path: `/tokens/${A}/card`, body: null };
    expect(await send(onMessage, read, mapFrame)).toEqual({ status: 200, body: "{}" });
    setStore(true);
    expect(await send(onMessage, read, mapFrame)).toBeUndefined();
  });

  it("cancels a map read the map gave up, at the API too (audit EX-10)", async () => {
    local.set("key", KEY);
    let signal: AbortSignal | undefined;
    api.site.mockImplementation(
      (_key: string, _read: unknown, s: AbortSignal) =>
        new Promise((_, reject) => {
          signal = s;
          s.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const read = { type: "site", method: "GET", path: `/tokens/${A}/holders/wait`, body: null, id: "r1" };
    const answer = send(onMessage, read, panel);
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(await send(onMessage, { type: "siteCancel", id: "r1" }, panel)).toEqual({ ok: true });
    expect(signal!.aborted).toBe(true);
    expect(await answer).toMatchObject({ status: 499 });
    expect(await send(onMessage, { type: "siteCancel", id: "r1" }, panel)).toEqual({ ok: false });
  });
});

describe("Trade Buddy", () => {
  it("asks for no wallet list, so every wallet linked on Settings is followed (Card 11)", async () => {
    local.set("key", KEY);
    // A wallet added in the panel before 0.9.2 stays in the display choices, but isn't sent.
    local.set("tooltip", { buddyWallets: [B] });
    api.buddy.mockResolvedValue({
      coins: [],
      wallets: [A],
      solUsd: null,
      pro: false,
      readAt: "",
      chainAt: null,
    });
    expect(await send(onMessage, { type: "buddy" }, panel)).toMatchObject({ buddy: { wallets: [A] } });
    expect(api.buddy).toHaveBeenCalledWith(KEY);
  });
});

describe("TrenchScanner's site", () => {
  it("is the only origin that may ping or hand over a key", async () => {
    const other = { origin: "https://trenchscanner.app.evil.example" } as chrome.runtime.MessageSender;
    expect(await send(onMessageExternal, { type: "ping" }, other)).toBeUndefined();
    expect(await send(onMessageExternal, { type: "connect", key: KEY }, other)).toBeUndefined();
    expect(api.me).not.toHaveBeenCalled();
    const site = { origin: "https://trenchscanner.app" } as chrome.runtime.MessageSender;
    expect(await send(onMessageExternal, { type: "ping" }, site)).toMatchObject({
      ok: true,
      connected: false,
    });
  });

  it("names a refused key's account in the ping, and takes a key the API accepts", async () => {
    const site = { origin: "https://www.trenchscanner.app" } as chrome.runtime.MessageSender;
    local.set("key", KEY);
    local.set("wallet", "7xQ1…k2Ab");
    local.set("refused", true);
    expect(await send(onMessageExternal, { type: "ping" }, site)).toMatchObject({
      connected: false,
      refusedAccount: "7xQ1…k2Ab",
    });
    expect(await send(onMessageExternal, { type: "connect", key: "nope" }, site)).toMatchObject({
      ok: false,
    });
    api.me.mockResolvedValue({ wallet: "7xQ1…k2Ab", settings: {}, look: null });
    const fresh = `tsx_${"b".repeat(43)}`;
    expect(await send(onMessageExternal, { type: "connect", key: fresh }, site)).toEqual({ ok: true });
    expect(local.get("key")).toBe(fresh);
    expect(local.has("refused")).toBe(false);
  });
});

describe("alert and run notifications", () => {
  async function readFeed(tokens: OverlayToken[]) {
    api.feed.mockResolvedValue({ tokens });
    await send(onMessage, { type: "feed" }, panel);
    // noteAlerts runs after the answer: a status read queues behind nothing, so wait on storage.
    await vi.waitFor(() => expect(local.has("alertsNotified")).toBe(true));
  }

  it("marks what is there on the first read, then notifies a new alert once", async () => {
    local.set("key", KEY);
    local.set("tooltip", { panel: { notify: true, badge: true, hideUnsafe: false } });
    await readFeed([token({ mint: A, modelCalls: [call(5_000)] })]);
    expect(notices).toEqual([]);
    await readFeed([
      token({ mint: A, modelCalls: [call(5_000)] }),
      token({ mint: B, modelCalls: [call(5_000)] }),
    ]);
    await vi.waitFor(() => expect(notices.map((n) => n.id)).toEqual([`alert:${B}`]));
    await readFeed([
      token({ mint: A, modelCalls: [call(5_000)] }),
      token({ mint: B, modelCalls: [call(5_000)] }),
    ]);
    expect(notices).toHaveLength(1);
  });

  it("notifies a run level once, counting the peak, and a drop once", async () => {
    local.set("key", KEY);
    local.set("tooltip", {
      runs: { enabled: true, levels: { 2: true, 3: false, 5: true, 10: true }, dropPct: 50 },
    });
    await readFeed([token({ mint: A, liveMcapUsd: 5_100, modelCalls: [call(5_000)] })]);
    await vi.waitFor(() => expect(local.has("runsNotified")).toBe(true));
    expect(notices).toEqual([]);
    // Peaked past 2x between reads, back to 1.6x now.
    await readFeed([token({ mint: A, liveMcapUsd: 8_000, modelCalls: [call(5_000, 10_500)] })]);
    await vi.waitFor(() => expect(notices.map((n) => n.id)).toEqual([`alert:${A}:run2`]));
    expect(notices[0]!.title).toBe("RING peaked 2x after its alert");
    // The call was a minute old: inside the leaderboard's window, so no "not a win" line.
    expect(notices[0]!.message).toBe("Alerted at $5.0K, peaked past $10.0K.");
    await readFeed([token({ mint: A, liveMcapUsd: 9_000, modelCalls: [call(5_000, 10_500)] })]);
    await readFeed([token({ mint: A, liveMcapUsd: 2_000, modelCalls: [call(5_000, 10_500)] })]);
    await vi.waitFor(() => expect(notices.map((n) => n.id)).toEqual([`alert:${A}:run2`, `alert:${A}:drop`]));
    await readFeed([token({ mint: A, liveMcapUsd: 1_900, modelCalls: [call(5_000, 10_500)] })]);
    expect(notices).toHaveLength(2);
  });

  it("says a run past the leaderboard's 15-minute window isn't a win (audit EX-8)", async () => {
    local.set("key", KEY);
    local.set("tooltip", {
      runs: { enabled: true, levels: { 2: true, 3: false, 5: true, 10: true }, dropPct: 0 },
    });
    const old = 40 * 60_000;
    await readFeed([token({ mint: A, liveMcapUsd: 5_100, modelCalls: [call(5_000, null, old)] })]);
    await vi.waitFor(() => expect(local.has("runsNotified")).toBe(true));
    await readFeed([token({ mint: A, liveMcapUsd: 10_200, modelCalls: [call(5_000, 10_200, old)] })]);
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]!.message).toBe(
      "Alerted at $5.0K, now $10.2K. Over 15 minutes after the alert, so not a leaderboard win.",
    );
  });

  it("forgets the run marks when run alerts are off, and the alarm reads nothing then", async () => {
    local.set("key", KEY);
    local.set("runsNotified", { [A]: { level: 2, dropped: false } });
    await readFeed([token({ mint: A, modelCalls: [call(5_000)] })]);
    await vi.waitFor(() => expect(local.has("runsNotified")).toBe(false));
    api.feed.mockClear();
    local.set("tooltip", { panel: { notify: false, badge: false, hideUnsafe: false } });
    onAlarm({ name: "alerts" });
    await new Promise((r) => setTimeout(r, 10));
    expect(api.feed).not.toHaveBeenCalled();
  });
});
