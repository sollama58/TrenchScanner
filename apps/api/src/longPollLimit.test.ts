import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  LONG_POLL_PER_MINT,
  LONG_POLL_PER_USER,
  LongPollCeiling,
  longPollRateLimit,
} from "./longPollLimit.js";

describe("longPollRateLimit", () => {
  it("keys each coin apart, on top of the app's own key", async () => {
    const app = Fastify();
    app.decorate("rateLimitKey", async () => "user:u1:d1");
    const limit = longPollRateLimit(app, "mintAddress");
    const key = (mint: string) => limit.keyGenerator({ params: { mintAddress: mint } } as never);
    expect(await key("MintA")).toBe("user:u1:d1:MintA");
    expect(await key("MintB")).toBe("user:u1:d1:MintB");
    expect(limit.max).toBe(LONG_POLL_PER_MINT);
    await app.close();
  });

  it("leaves room for six open charts at 80 asks a minute", () => {
    expect(LONG_POLL_PER_MINT).toBeGreaterThanOrEqual(80);
    expect(LONG_POLL_PER_USER).toBeGreaterThanOrEqual(6 * 80);
  });
});

describe("LongPollCeiling", () => {
  it("caps one key a minute, and starts over the next", () => {
    let now = 0;
    const ceiling = new LongPollCeiling(3, 10, () => now);
    expect([1, 2, 3, 4].map(() => ceiling.allow("u"))).toEqual([true, true, true, false]);
    expect(ceiling.allow("v")).toBe(true);
    now = 60_000;
    expect(ceiling.allow("u")).toBe(true);
  });
});
