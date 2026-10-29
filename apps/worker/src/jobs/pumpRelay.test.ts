import type { Env, TokenSagePumpCoinAnswer } from "@trenchscanner/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PER_MIN, relayCoin, resetPumpRelay, takePumpRelayStats } from "./pumpRelay.js";

const env = {
  TOKENSAGE_ENABLED: true,
  TOKENSAGE_API_URL: "https://tokensage.test",
  TOKENSAGE_API_KEY: "k",
  TOKENSAGE_TIMEOUT_MS: 8000,
} as Pick<Env, "TOKENSAGE_ENABLED" | "TOKENSAGE_API_URL" | "TOKENSAGE_API_KEY" | "TOKENSAGE_TIMEOUT_MS">;

const answer = (extra: Partial<TokenSagePumpCoinAnswer>): TokenSagePumpCoinAnswer => ({
  ca: "m",
  status: "ok",
  ...extra,
});

describe("relayCoin", () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
    resetPumpRelay(() => now);
  });

  it("reads the relay's coin as Pump.fun's own read, and counts how the relay answered", async () => {
    const pumpCoin = vi
      .fn()
      .mockResolvedValueOnce(
        answer({
          coin: {
            mint: "a",
            symbol: "BLORBO",
            description: "a frog",
            twitter: "https://x.com/blorbo",
            image_uri: "http://insecure.example/x.png",
            created_timestamp: Date.parse("2026-10-29T10:00:00Z"),
            complete: false,
            mayhem_state: null,
          },
        }),
      )
      .mockResolvedValueOnce(answer({ coin: { mint: "someone else" } }))
      .mockResolvedValueOnce(answer({ status: "refused", cf_mitigated: "challenge" }))
      .mockResolvedValueOnce(answer({ status: "busy" }))
      .mockRejectedValueOnce(new Error("socket hang up"));
    const got = await relayCoin("a", env, { pumpCoin });
    expect(got).toMatchObject({
      mintAddress: "a",
      symbol: "BLORBO",
      description: "a frog",
      hasTwitter: true,
      graduated: false,
      createdAt: new Date("2026-10-29T10:00:00Z"),
    });
    expect(got?.imageUrl).toBeUndefined(); // only https is kept
    expect(got?.mayhemMode).toBeUndefined();
    for (const m of ["b", "c", "d", "e"]) expect(await relayCoin(m, env, { pumpCoin })).toBeNull();
    expect(takePumpRelayStats()).toEqual({
      asked: 5,
      ok: 1,
      notFound: 1,
      refused: 1,
      challenged: 1,
      unavailable: 0,
      busy: 1,
      failed: 1,
      capped: 0,
    });
    expect(takePumpRelayStats().asked).toBe(0);
  });

  it("asks at most MAX_PER_MIN coins a minute", async () => {
    const pumpCoin = vi.fn(async () => answer({ status: "not_found" }));
    for (let i = 0; i < MAX_PER_MIN + 3; i++) await relayCoin(`m${i}`, env, { pumpCoin });
    expect(pumpCoin).toHaveBeenCalledTimes(MAX_PER_MIN);
    expect(takePumpRelayStats()).toMatchObject({ asked: MAX_PER_MIN, capped: 3 });
    now = 60_000;
    await relayCoin("later", env, { pumpCoin });
    expect(pumpCoin).toHaveBeenCalledTimes(MAX_PER_MIN + 1);
  });

  it("does nothing with TokenSage off", async () => {
    const pumpCoin = vi.fn();
    expect(await relayCoin("a", { ...env, TOKENSAGE_ENABLED: false }, { pumpCoin })).toBeNull();
    expect(pumpCoin).not.toHaveBeenCalled();
    expect(takePumpRelayStats().asked).toBe(0);
  });
});
