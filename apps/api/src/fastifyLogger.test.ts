import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { fastifyLogger } from "./fastifyLogger.js";

afterEach(() => vi.restoreAllMocks());

function lastLine(spy: ReturnType<typeof vi.spyOn>) {
  return JSON.parse(String(spy.mock.calls.at(-1)?.[0]));
}

describe("fastifyLogger", () => {
  it("prints pino-style (meta, msg) calls with errors reduced to message and stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fastifyLogger()
      .child({ reqId: "req-1" })
      .error({ err: new Error("boom") }, "update failed");
    const line = lastLine(spy);
    expect(line.level).toBe("error");
    expect(line.scope).toBe("api");
    expect(line.msg).toBe("update failed");
    expect(line.meta.reqId).toBe("req-1");
    expect(line.meta.err.message).toBe("boom");
  });

  it("makes app.log and request.log print instead of being no-ops", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = Fastify({ loggerInstance: fastifyLogger(), disableRequestLogging: true });
    app.get("/x", async (request) => {
      request.log.warn({ ip: "1.2.3.4" }, "bad secret");
      return { ok: true };
    });
    await app.inject({ method: "GET", url: "/x" });
    const line = lastLine(warn);
    expect(line.msg).toBe("bad secret");
    expect(line.meta.ip).toBe("1.2.3.4");
    await app.close();
  });
});
