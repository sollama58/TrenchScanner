import { describe, expect, it } from "vitest";
import { HttpError } from "./httpClient.js";
import { endpointOf, PumpFunGate } from "./pumpfunGate.js";

describe("PumpFunGate", () => {
  it("lets a burst through, then holds back past the budget without waiting", async () => {
    let now = 0;
    const gate = new PumpFunGate("test", 60, 2, 30_000, () => now);
    await gate.acquire();
    await gate.acquire();
    await expect(gate.acquire()).rejects.toMatchObject({ status: 429 });
    now += 1_000; // one slot a second at 60 a minute
    await gate.acquire();
    expect(gate.takeStats()).toEqual({
      requests: 3,
      throttled: 0,
      heldBack: 1,
      refused: 0,
      heldBackRefused: 0,
      challenged: 0,
    });
  });

  it("pauses every request for at least its pause on a 429, then starts from an empty bucket", async () => {
    let now = 0;
    const gate = new PumpFunGate("test", 600, 10, 30_000, () => now);
    gate.throttled(500);
    const held = await gate.acquire().catch((err: unknown) => err);
    expect(held).toBeInstanceOf(HttpError);
    now = 29_999;
    await expect(gate.acquire()).rejects.toBeInstanceOf(HttpError);
    now = 30_000 + 100; // one slot per 100 ms after the pause
    await gate.acquire();
    await expect(gate.acquire()).rejects.toBeInstanceOf(HttpError);
    expect(gate.takeStats()).toMatchObject({ throttled: 1, requests: 1 });
  });

  it("holds back only the endpoint that answered 403, then lets one probe ask", () => {
    let now = 0;
    const gate = new PumpFunGate("test", 600, 10, 30_000, () => now, 60_000);
    const mintA = "https://frontend-api-v3.pump.fun/coins-v2/" + "A".repeat(44);
    const mintB = "https://frontend-api-v3.pump.fun/coins-v2/" + "B".repeat(43) + "pump";
    const live = "https://frontend-api-v3.pump.fun/coins/currently-live?offset=0";
    gate.refused(mintA);
    expect(gate.refusedRecently(mintB)).toBe(true);
    expect(gate.refusedRecently(live)).toBe(false);
    now = 60_000;
    expect(gate.refusedRecently(mintA)).toBe(false); // the probe
    expect(gate.refusedRecently(mintB)).toBe(true); // waits for the probe's answer
    now = 75_000;
    expect(gate.refusedRecently(mintB)).toBe(false); // the probe never answered: another asks
    gate.answered(mintB);
    expect(gate.refusedRecently(mintA)).toBe(false);
    expect(gate.takeStats()).toMatchObject({ refused: 1, heldBackRefused: 2 });
  });

  it("counts the 403s Cloudflare marked as its managed challenge (check-in 2026-10-29)", () => {
    const gate = new PumpFunGate("test", 600, 10);
    const url = "https://frontend-api-v3.pump.fun/coins-v2/" + "A".repeat(44);
    gate.refused(url, new Headers({ "cf-mitigated": "challenge" }));
    gate.refused(url, new Headers());
    gate.refused(url);
    expect(gate.takeStats()).toMatchObject({ refused: 3, challenged: 1 });
  });

  it("names an endpoint by its path with the coin left out", () => {
    expect(endpointOf("https://swap-api.pump.fun/v1/coins/" + "C".repeat(44) + "/candles?interval=1m")).toBe(
      "swap-api.pump.fun/v1/coins/*/candles",
    );
    expect(endpointOf("https://frontend-api-v3.pump.fun/coins?offset=0")).toBe(
      "frontend-api-v3.pump.fun/coins",
    );
  });
});
