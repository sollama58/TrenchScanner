import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { sizeRouteRateLimits } from "./rateLimitBuckets.js";

/** Route-level limits keep their buckets past the plugin's default 5,000 (audit 2026-10-23, CE-9). */
describe("sizeRouteRateLimits", () => {
  async function server() {
    const app = Fastify();
    sizeRouteRateLimits(app);
    await app.register(rateLimit, { global: false });
    const config = {
      rateLimit: {
        max: 1,
        timeWindow: "1 minute",
        keyGenerator: (r: { headers: Record<string, unknown> }) => String(r.headers["x-k"]),
      },
    };
    app.get("/limited", { config }, async () => "ok");
    app.get("/ext/v1/limited", { config }, async () => "ok");
    await app.ready();
    return app;
  }
  const hit = (app: Awaited<ReturnType<typeof server>>, url: string, key: string) =>
    app.inject({ method: "GET", url, headers: { "x-k": key } }).then((r) => r.statusCode);

  it("keeps a caller's bucket while 5,000 other callers come through, and leaves /ext/v1 alone", async () => {
    const app = await server();
    for (const url of ["/limited", "/ext/v1/limited"]) {
      expect(await hit(app, url, "first")).toBe(200);
      expect(await hit(app, url, "first")).toBe(429);
      for (let i = 0; i < 5_001; i++) await hit(app, url, `k${i}`);
    }
    // Still remembered on the sized route; flushed out of the default-sized one.
    expect(await hit(app, "/limited", "first")).toBe(429);
    expect(await hit(app, "/ext/v1/limited", "first")).toBe(200);
    await app.close();
  }, 30_000);
});
