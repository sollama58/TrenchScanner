import { describe, expect, it } from "vitest";
import { HttpError } from "./httpClient.js";
import { PumpFunGate } from "./pumpfunGate.js";

describe("PumpFunGate", () => {
  it("lets a burst through, then holds back past the budget without waiting", async () => {
    let now = 0;
    const gate = new PumpFunGate("test", 60, 2, 30_000, () => now);
    await gate.acquire();
    await gate.acquire();
    await expect(gate.acquire()).rejects.toMatchObject({ status: 429 });
    now += 1_000; // one slot a second at 60 a minute
    await gate.acquire();
    expect(gate.takeStats()).toEqual({ requests: 3, throttled: 0, heldBack: 1 });
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
});
