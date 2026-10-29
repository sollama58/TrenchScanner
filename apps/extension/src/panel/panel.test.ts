// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { token } from "../shared/testToken";
import type { FeedAnswer, OverlayToken, Status } from "../shared/types";

// The side panel's poll loop and its bubble maps (chart audit 2026-10-29), against a fake `chrome`
// whose worker answers from the test. The site's map is mocked: nothing is read.

const A = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";

const maps = vi.hoisted(() => ({ made: [] as string[], stopped: [] as string[] }));
vi.mock("../map/siteMap", () => ({
  siteMapNode: (mint: string) => {
    maps.made.push(mint);
    return { node: document.createElement("div"), stop: () => void maps.stopped.push(mint) };
  },
}));

const status: Status = {
  connected: true,
  wallet: "7xQ1…k2Ab",
  aiReviews: false,
  pro: false,
  settings: DEFAULT_SETTINGS,
  problem: null,
};
let tokens: OverlayToken[] = [];
/** How long a status read takes; status reads under way, and the most at once. */
let slowMs = 0;
let reading = 0;
let mostReading = 0;

function answer(request: { type: string }): Promise<unknown> {
  switch (request.type) {
    case "status":
      if (slowMs === 0) return Promise.resolve(status);
      reading++;
      mostReading = Math.max(mostReading, reading);
      return new Promise((resolve) =>
        setTimeout(() => {
          reading--;
          resolve(status);
        }, slowMs),
      );
    case "feed":
      return Promise.resolve({ tokens, problem: null } satisfies FeedAnswer);
    default:
      return Promise.resolve(null);
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="account"></div><main id="app"></main>`;
  (globalThis as { __STORE__?: boolean }).__STORE__ = false;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id: "jhdfdijmhnomcdijohdfibelodhfiigl",
      getURL: (path: string) => `chrome-extension://x/${path}`,
      sendMessage: answer,
      onMessage: { addListener: () => undefined },
    },
  };
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  tokens = [
    token({
      mint: A,
      modelCalls: [
        {
          model: "m1",
          name: "Model One",
          tier: "high",
          confidence: 70,
          calibratedPct: 22,
          at: new Date().toISOString(),
          mcapUsd: 5_000,
        },
      ],
    }),
  ];
  await import("./panel");
  await flush();
});

afterAll(() => {
  vi.useRealTimers();
});

describe("the side panel", () => {
  it("stops an open map once its alert is no longer listed", async () => {
    const toggle = document.querySelector<HTMLButtonElement>("#app .map-toggle");
    expect(toggle).not.toBeNull();
    toggle!.click();
    expect(maps.made).toEqual([A]);
    // The alert leaves the list: the map is no longer drawn, so it stops following the coin.
    tokens = [];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(document.querySelector("#app .map-toggle")).toBeNull();
    expect(maps.stopped).toEqual([A]);
  });

  it("keeps one poll loop when a poll starts while a slow one is reading", async () => {
    // Let the loop settle on its own timer; from here each status read takes 8 s, longer than
    // the 5 s between polls (an API that answers slowly).
    await vi.advanceTimersByTimeAsync(5_000);
    slowMs = 8_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reading).toBe(1);
    // The panel is shown again while that poll reads: a second poll starts.
    await vi.advanceTimersByTimeAsync(6_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(reading).toBe(2);
    // Once the first two are done, only one loop is left: never two reads at once.
    await vi.advanceTimersByTimeAsync(10_000);
    mostReading = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mostReading).toBe(1);
    slowMs = 0;
  });
});
