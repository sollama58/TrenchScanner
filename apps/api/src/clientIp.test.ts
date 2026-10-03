import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { clientIp } from "./clientIp.js";

function request(headers: Record<string, string>): FastifyRequest {
  // request.ip is what trustProxy derives from X-Forwarded-For: the client-controlled entry.
  return { headers, ip: headers["x-forwarded-for"] ?? "10.0.0.1" } as never;
}

describe("clientIp", () => {
  it("uses Cloudflare's CF-Connecting-IP, never the client-written X-Forwarded-For", () => {
    const req = request({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" });
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  it("falls back to request.ip when Cloudflare isn't in front", () => {
    expect(clientIp(request({}))).toBe("10.0.0.1");
  });

  it("ignores a CF-Connecting-IP that isn't an IP literal", () => {
    expect(clientIp(request({ "cf-connecting-ip": "evil, 1.2.3.4" }))).toBe("10.0.0.1");
  });
});
