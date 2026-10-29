import type { Env, TokenSagePumpCoinAnswer } from "@trenchscanner/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROBE_EVERY_MS,
  probePumpRelay,
  resetPumpRelayProbe,
  takePumpRelayProbeStats,
} from "./pumpRelayProbe.js";

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

describe("probePumpRelay", () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
    resetPumpRelayProbe(() => now);
  });

  it("asks at most one coin a minute and counts how TokenSage's relay answered", async () => {
    const pumpCoin = vi
      .fn()
      .mockResolvedValueOnce(answer({ status: "ok" }))
      .mockResolvedValueOnce(answer({ status: "refused", cf_mitigated: "challenge" }))
      .mockRejectedValueOnce(new Error("socket hang up"));
    await probePumpRelay("a", env, { pumpCoin });
    await probePumpRelay("b", env, { pumpCoin }); // within the minute: not asked
    now = PROBE_EVERY_MS;
    await probePumpRelay("c", env, { pumpCoin });
    now = 2 * PROBE_EVERY_MS;
    await probePumpRelay("d", env, { pumpCoin });
    expect(pumpCoin.mock.calls.map((c) => c[0])).toEqual(["a", "c", "d"]);
    expect(takePumpRelayProbeStats()).toEqual({
      asked: 3,
      ok: 1,
      notFound: 0,
      refused: 1,
      challenged: 1,
      unavailable: 0,
      busy: 0,
      failed: 1,
    });
    expect(takePumpRelayProbeStats().asked).toBe(0);
  });

  it("does nothing with TokenSage off", async () => {
    const pumpCoin = vi.fn();
    await probePumpRelay("a", { ...env, TOKENSAGE_ENABLED: false }, { pumpCoin });
    expect(pumpCoin).not.toHaveBeenCalled();
    expect(takePumpRelayProbeStats().asked).toBe(0);
  });
});
