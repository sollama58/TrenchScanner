// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { loadEnv } from "@trenchscanner/core";
import { buildServer } from "../server.js";

/**
 * bs58.decode is quadratic in input length, so an uncapped address field let a single
 * unauthenticated request pin the event loop for minutes. Rejection has to happen on length,
 * before any decode - which is what the timing bound here checks. No database needed: validation
 * fails before any query runs.
 */
describe("sign-in input caps", () => {
  it("rejects an oversized walletAddress quickly, without decoding it", async () => {
    const app = await buildServer(loadEnv());
    try {
      const started = Date.now();
      const res = await app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: { method: "signMessage", walletAddress: "z".repeat(200_000), nonce: "x", signature: "x" },
      });
      expect(res.statusCode).toBe(400);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      await app.close();
    }
  });

  it("rejects an oversized signature", async () => {
    const app = await buildServer(loadEnv());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: {
          method: "signMessage",
          walletAddress: "11111111111111111111111111111111",
          nonce: "x",
          signature: "z".repeat(5_000),
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
