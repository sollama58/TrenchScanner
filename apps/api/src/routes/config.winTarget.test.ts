// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { type Env, setWinTargetRule } from "@trenchscanner/core";
import { registerConfigRoutes } from "./config.js";

/**
 * GET /config/win-target (program audit 2026-11-28, card 1 step 3): the site words its hit rates
 * from this, so it has to follow WIN_TARGET_RULE, and a page that kept "15 minutes, 50% stop"
 * beside rates counted on the fill target would state the wrong rule.
 */
describe("GET /config/win-target", () => {
  afterEach(() => setWinTargetRule("classic"));

  async function read() {
    const app = Fastify();
    await app.register(registerConfigRoutes, { prefix: "/config", env: {} as Env });
    const res = await app.inject({ method: "GET", url: "/config/win-target" });
    await app.close();
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  }

  it("is the classic rule by default", async () => {
    expect(await read()).toMatchObject({
      rule: "classic",
      windowMinutes: 15,
      multiple: 2,
      stopPct: 50,
      base: "alert",
      short: "2x in 15m",
    });
  });

  it("follows the switch, whichever of the switch and the routes was set up first", async () => {
    const app = Fastify();
    await app.register(registerConfigRoutes, { prefix: "/config", env: {} as Env });
    setWinTargetRule("fill30");
    const res = await app.inject({ method: "GET", url: "/config/win-target" });
    await app.close();
    expect(res.json()).toMatchObject({ rule: "fill30", windowMinutes: 30, stopPct: 30, base: "fill" });
    expect(await read()).toMatchObject({ rule: "fill30" });
  });
});
