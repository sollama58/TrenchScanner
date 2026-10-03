import { describe, expect, it } from "vitest";
import { backoffDelay, fetchJson, MAX_RESPONSE_BYTES, redactUrl } from "./httpClient.js";

describe("redactUrl", () => {
  it("redacts Helius's own api-key query param", () => {
    const redacted = redactUrl("https://mainnet.helius-rpc.com/?api-key=super-secret-value");
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).toContain("api-key=REDACTED");
  });

  it("redacts other common secret param spellings", () => {
    expect(redactUrl("https://example.com/x?apikey=abc")).not.toContain("abc");
    expect(redactUrl("https://example.com/x?api_key=abc")).not.toContain("abc");
    expect(redactUrl("https://example.com/x?key=abc")).not.toContain("abc");
    expect(redactUrl("https://example.com/x?token=abc")).not.toContain("abc");
    expect(redactUrl("https://example.com/x?secret=abc")).not.toContain("abc");
  });

  it("leaves non-sensitive query params and the rest of the URL untouched", () => {
    const redacted = redactUrl("https://api.dexscreener.com/tokens/v1/solana/abc,def?foo=bar");
    expect(redacted).toContain("foo=bar");
    expect(redacted).toContain("/tokens/v1/solana/abc,def");
  });

  it("leaves a URL with no query params entirely unchanged", () => {
    const url = "https://api.rugcheck.xyz/v1/tokens/abc123/report";
    expect(redactUrl(url)).toBe(url);
  });

  it("redacts a key carried in the path or the userinfo", () => {
    const quicknode = redactUrl("https://x.solana-mainnet.quiknode.pro/0123456789abcdef0123456789abcdef/");
    expect(quicknode).not.toContain("0123456789abcdef0123456789abcdef");
    expect(redactUrl("https://solana-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz")).toBe(
      "https://solana-mainnet.g.alchemy.com/v2/REDACTED",
    );
    expect(redactUrl("https://user:hunter2@rpc.example.com/")).not.toContain("hunter2");
  });

  it("falls back to returning the input unchanged if it isn't a parseable absolute URL", () => {
    expect(redactUrl("not a url at all")).toBe("not a url at all");
  });
});

describe("fetchJson", () => {
  it("refuses a response body larger than MAX_RESPONSE_BYTES", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      for (let i = 0; i <= MAX_RESPONSE_BYTES / chunk.length; i++) res.write(chunk);
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    try {
      await expect(fetchJson(`http://127.0.0.1:${port}/`, { retries: 0 })).rejects.toMatchObject({
        status: 413,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("times out a response whose body stalls after the headers arrive", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial":');
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    try {
      await expect(
        fetchJson(`http://127.0.0.1:${port}/`, { timeoutMs: 200, retries: 0 }),
      ).rejects.toMatchObject({ status: 408 });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("backoffDelay", () => {
  it("honours a Retry-After in seconds, capped", () => {
    expect(backoffDelay(500, 0, "2")).toBe(2000);
    expect(backoffDelay(500, 0, "600")).toBe(10_000);
  });

  it("jitters the exponential delay within [exp/2, 1.5*exp]", () => {
    for (let i = 0; i < 20; i++) {
      const d = backoffDelay(500, 1, null);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1500);
    }
  });
});
