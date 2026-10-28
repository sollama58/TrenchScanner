import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const MINT = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
const ORIGIN = "https://trenchscanner.app";
const source = readFileSync(resolve(import.meta.dirname, "../public/sw.js"), "utf8");

type Listener = (event: unknown) => void;

/** Runs public/sw.js against a fake worker scope and clicks one notification. */
async function click(notification: { tag?: string; data?: { url?: string } }, openWindows: string[]) {
  const listeners: Record<string, Listener> = {};
  const posted: unknown[] = [];
  const opened: string[] = [];
  const focused: string[] = [];
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () =>
        openWindows.map((url) => ({
          url,
          postMessage: (m: unknown) => posted.push(m),
          focus: async () => focused.push(url),
        })),
      openWindow: async (url: string) => opened.push(url),
    },
  };
  runInNewContext(source, { self, URL });
  let work: Promise<unknown> = Promise.resolve();
  listeners.notificationclick!({
    notification: { ...notification, close: () => undefined },
    waitUntil: (p: Promise<unknown>) => (work = p),
  });
  await work;
  return { posted, opened, focused };
}

describe("notification click (public/sw.js)", () => {
  it("opens a push's coin in a new window (the push names it in its tag)", async () => {
    // Audit 10-27 WB-31: a click focused a tab or opened the dashboard, never the alert.
    const r = await click({ tag: `ts-alert-${MINT}`, data: { url: `${ORIGIN}/` } }, []);
    expect(r.opened).toEqual([`${ORIGIN}/?token=${MINT}`]);
  });

  it("asks an open tab to show the coin, then focuses it", async () => {
    const r = await click({ tag: "kind:1", data: { url: `/?token=${MINT}` } }, [`${ORIGIN}/#live`]);
    expect(r.posted).toEqual([{ type: "ts-open-token", mint: MINT }]);
    expect(r.focused).toEqual([`${ORIGIN}/#live`]);
    expect(r.opened).toEqual([]);
  });

  it("focuses an open tab without a message for a batch notification", async () => {
    const r = await click({ tag: "ts-batch", data: { url: `${ORIGIN}/` } }, [`${ORIGIN}/`]);
    expect(r.posted).toEqual([]);
    expect(r.focused).toHaveLength(1);
  });

  it("never leaves the site, and drops a token that is not a mint", async () => {
    const away = await click({ data: { url: `https://evil.example/?token=${MINT}` } }, []);
    expect(away.opened).toEqual([`${ORIGIN}/`]);
    const junk = await click({ tag: "ts-alert-<script>", data: { url: "/" } }, []);
    expect(junk.opened).toEqual([`${ORIGIN}/`]);
  });
});
