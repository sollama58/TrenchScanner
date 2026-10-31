import { describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  ERROR_BODY_MAX_CHARS,
  fetchJson,
  HttpError,
  MAX_RESPONSE_BYTES,
  networkFailure,
  redactUrl,
} from "./httpClient.js";

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

describe("fetchJson timeouts", () => {
  it("retries a timeout unless told not to, and reports every retry", async () => {
    const { createServer } = await import("node:http");
    let hits = 0;
    const server = createServer(() => {
      hits += 1; // never answers
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/`;
    try {
      let retried = 0;
      await expect(
        fetchJson(url, { timeoutMs: 100, retries: 1, retryDelayMs: 1, onRetry: () => (retried += 1) }),
      ).rejects.toMatchObject({ status: 408 });
      expect([hits, retried]).toEqual([2, 1]);

      hits = 0;
      retried = 0;
      await expect(
        fetchJson(url, { timeoutMs: 100, retries: 1, retryOnTimeout: false, onRetry: () => (retried += 1) }),
      ).rejects.toMatchObject({ status: 408 });
      expect([hits, retried]).toEqual([1, 0]);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("fetchJson network errors", () => {
  const socketError = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

  it("sorts socket errors into never-sent, cut mid-request, and not worth a retry", () => {
    expect(networkFailure(socketError("ECONNREFUSED"))).toBe("unsent");
    expect(networkFailure(socketError("ENOTFOUND"))).toBe("unsent");
    expect(networkFailure(socketError("ECONNRESET"))).toBe("cut");
    expect(networkFailure(socketError("UND_ERR_SOCKET"))).toBe("cut");
    expect(networkFailure(Object.assign(new Error("x"), { name: "AbortError" }))).toBeNull();
    expect(networkFailure(new TypeError("Invalid URL"))).toBeNull();
    expect(networkFailure("nope")).toBeNull();
  });

  it("retries a reset once instead of failing the whole read (audit 2026-10-27, DA-13)", async () => {
    let calls = 0;
    let retried = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) throw socketError("ECONNRESET");
      return new Response('{"ok":true}');
    });
    try {
      const body = await fetchJson("https://example.com/x", {
        retries: 1,
        retryDelayMs: 1,
        onRetry: () => (retried += 1),
      });
      expect(body).toEqual({ ok: true });
      expect([calls, retried]).toEqual([2, 1]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("doesn't resend a cut request that may have been billed when timeouts aren't retried", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      throw socketError(calls === 1 ? "ECONNRESET" : "ECONNREFUSED");
    });
    try {
      await expect(
        fetchJson("https://example.com/x", { retries: 2, retryDelayMs: 1, retryOnTimeout: false }),
      ).rejects.toThrow("fetch failed");
      expect(calls).toBe(1);
      // One that never left is retried either way, up to `retries`.
      calls = 1;
      await expect(
        fetchJson("https://example.com/x", { retries: 2, retryDelayMs: 1, retryOnTimeout: false }),
      ).rejects.toThrow("fetch failed");
      expect(calls).toBe(4);
      calls = 1;
      await expect(fetchJson("https://example.com/x", { retries: 0 })).rejects.toThrow("fetch failed");
      expect(calls).toBe(2);
    } finally {
      vi.unstubAllGlobals();
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

describe("fetchJson refusal breaker", () => {
  it("tells the gate about a 403, then fails as that 403 without sending while it holds back", async () => {
    const { createServer } = await import("node:http");
    let hits = 0;
    let status = 403;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/coins-v2/x`;
    const { PumpFunGate } = await import("./pumpfunGate.js");
    let now = 0;
    const gate = new PumpFunGate("test", 600, 10, 30_000, () => now, 60_000);
    try {
      await expect(fetchJson(url, { retries: 0, gate })).rejects.toMatchObject({ status: 403 });
      await expect(fetchJson(url, { retries: 0, gate })).rejects.toMatchObject({ status: 403 });
      expect(hits).toBe(1);

      now = 60_000; // the probe goes out and the endpoint answers again
      status = 200;
      await expect(fetchJson(url, { retries: 0, gate })).resolves.toEqual({});
      await expect(fetchJson(url, { retries: 0, gate })).resolves.toEqual({});
      expect(hits).toBe(3);
      expect(gate.takeStats()).toMatchObject({ refused: 1, heldBackRefused: 1 });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("fetchJson error bodies", () => {
  it("keeps a 4xx body on the error only when asked", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response('{"error":"unable to generate report"}', { status: 400 }),
    );
    try {
      await expect(fetchJson("https://example.com/x", { retries: 0, errorBody: true })).rejects.toMatchObject(
        {
          status: 400,
          body: '{"error":"unable to generate report"}',
        },
      );
      await expect(fetchJson("https://example.com/x", { retries: 0 })).rejects.toMatchObject({
        status: 400,
        body: undefined,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("caps the kept body", async () => {
    vi.stubGlobal("fetch", async () => new Response("x".repeat(ERROR_BODY_MAX_CHARS * 2), { status: 404 }));
    try {
      const err = (await fetchJson("https://example.com/x", { retries: 0, errorBody: true }).catch(
        (e: unknown) => e,
      )) as HttpError;
      expect(err).toBeInstanceOf(HttpError);
      expect(err.body).toHaveLength(ERROR_BODY_MAX_CHARS);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
