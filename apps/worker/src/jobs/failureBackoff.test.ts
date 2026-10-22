import { afterEach, describe, expect, it } from "vitest";
import { clearHeliusCreditsOut, meteredFetch } from "@trenchscanner/core";
import { FailureBackoff } from "./failureBackoff.js";

const MIN = 60_000;

describe("FailureBackoff", () => {
  it("waits 2 minutes after one failure, doubling to a 20-minute cap", () => {
    const backoff = new FailureBackoff();
    let now = 0;
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      backoff.fail("w", now);
      let wait = 0;
      while (backoff.blocked("w", now + wait * MIN)) wait += 1;
      waits.push(wait);
      now += wait * MIN;
    }
    expect(waits).toEqual([2, 4, 8, 16, 20, 20]);
  });

  it("forgets a key on success", () => {
    const backoff = new FailureBackoff();
    backoff.fail("w", 0);
    backoff.fail("w", 2 * MIN);
    backoff.succeed("w");
    expect(backoff.blocked("w", 2 * MIN)).toBe(false);
    backoff.fail("w", 3 * MIN);
    expect(backoff.blocked("w", 5 * MIN - 1)).toBe(true);
    expect(backoff.blocked("w", 5 * MIN)).toBe(false);
  });

  it("takes a fixed wait without escalating", () => {
    const backoff = new FailureBackoff();
    backoff.fail("m", 0, 1);
    backoff.fail("m", MIN, 1);
    expect(backoff.blocked("m", 2 * MIN)).toBe(false);
    backoff.fail("m", 2 * MIN);
    expect(backoff.blocked("m", 4 * MIN - 1)).toBe(true);
    expect(backoff.blocked("m", 4 * MIN)).toBe(false);
  });

  it("starts a key over once it has been quiet past the cap", () => {
    const backoff = new FailureBackoff();
    backoff.fail("w", 0);
    backoff.prune(2 * MIN + 20 * MIN);
    backoff.fail("w", 22 * MIN);
    expect(backoff.blocked("w", 24 * MIN)).toBe(false);
  });
});

/** Answers one billed Helius call with `body` and `status`, through the stand-down's meter. */
async function heliusAnswers(status: number, body: string) {
  const f = meteredFetch(
    (async () =>
      new Response(body, { status, headers: { "content-type": "application/json" } })) as typeof fetch,
  );
  await f("https://mainnet.helius-rpc.com/?api-key=k", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "getMultipleAccounts", params: [] }),
  });
}

describe("FailureBackoff of Helius lookups", () => {
  afterEach(() => clearHeliusCreditsOut());

  it("takes no strikes while Helius's credits are out, and forgets every key when they're back", async () => {
    const backoff = new FailureBackoff(2, 20, { helius: true });
    const plain = new FailureBackoff();
    await heliusAnswers(429, '{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}');
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      backoff.fail("mint", now);
      plain.fail("mint", now);
    }
    // A flat minute, not the 20-minute cap.
    expect(backoff.blocked("mint", now + MIN - 1)).toBe(true);
    expect(backoff.blocked("mint", now + MIN)).toBe(false);
    expect(plain.blocked("mint", now + 19 * MIN)).toBe(true);

    clearHeliusCreditsOut();
    expect(backoff.blocked("mint", now)).toBe(false);
    expect(plain.blocked("mint", now)).toBe(true);
  });

  it("treats a failure just after a Helius 429 as the provider's", async () => {
    const backoff = new FailureBackoff(2, 20, { helius: true });
    await heliusAnswers(429, '{"jsonrpc":"2.0","error":{"code":-32429,"message":"rate limited"}}');
    backoff.fail("mint", 0);
    backoff.fail("mint", 0);
    expect(backoff.blocked("mint", MIN)).toBe(false);
  });
});
