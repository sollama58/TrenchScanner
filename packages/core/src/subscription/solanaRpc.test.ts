import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSolanaRpcUrl, SolanaRpc } from "./solanaRpc.js";

let server: Server | undefined;

/** A local JSON-RPC endpoint; the handler sees the raw request body (an object or a batch array). */
async function startServer(handler: (body: unknown) => unknown): Promise<{ url: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(handler(body)));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
  return { url: `http://127.0.0.1:${address.port}`, bodies };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("resolveSolanaRpcUrl", () => {
  const helius = "https://mainnet.helius-rpc.com/?api-key=k";

  it("uses Helius when SOLANA_RPC_URL is unset and a key exists", () => {
    expect(resolveSolanaRpcUrl({ apiKey: "k" })).toBe(helius);
  });

  it("prefers Helius over a public endpoint in SOLANA_RPC_URL", () => {
    expect(resolveSolanaRpcUrl({ rpcUrl: "https://api.mainnet-beta.solana.com", apiKey: "k" })).toBe(helius);
    expect(resolveSolanaRpcUrl({ rpcUrl: "https://solana-rpc.publicnode.com/", apiKey: "k" })).toBe(helius);
  });

  it("keeps a paid SOLANA_RPC_URL, and the public one when there is no key", () => {
    expect(resolveSolanaRpcUrl({ rpcUrl: "https://example.quiknode.pro/abc/", apiKey: "k" })).toBe(
      "https://example.quiknode.pro/abc/",
    );
    expect(resolveSolanaRpcUrl({ rpcUrl: "https://api.mainnet-beta.solana.com" })).toBe(
      "https://api.mainnet-beta.solana.com",
    );
    expect(resolveSolanaRpcUrl({})).toBe("https://api.mainnet-beta.solana.com");
  });
});

describe("SolanaRpc", () => {
  it("reports its host, never the key", () => {
    expect(new SolanaRpc({ apiKey: "secret" }).provider).toBe("mainnet.helius-rpc.com");
  });

  it("falls back to single calls when a batch is answered with one error object", async () => {
    const { url, bodies } = await startServer((body) =>
      Array.isArray(body)
        ? { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch requests not allowed" } }
        : { jsonrpc: "2.0", id: 1, result: { slot: 1, signature: (body as { params: string[] }).params[0] } },
    );
    const rpc = new SolanaRpc({ rpcUrl: url });

    const first = await rpc.getParsedTransactions(["a", "b"]);
    expect([...first.keys()]).toEqual(["a", "b"]);
    expect(first.get("a")).not.toBeNull();
    expect(first.get("b")).not.toBeNull();

    // Latched: the next call goes straight to single requests, no batch attempted.
    bodies.length = 0;
    await rpc.getParsedTransactions(["c"]);
    expect(bodies.every((b) => !Array.isArray(b))).toBe(true);

    // 2 in the refused batch + 2 singles + 1 single afterwards.
    expect(rpc.takeCallStats()).toEqual({ getTransaction: 5 });
    expect(rpc.takeCallStats()).toEqual({});
  });

  it("retries a batch's errored calls one at a time and keeps the error for health", async () => {
    const { url } = await startServer((body) =>
      Array.isArray(body)
        ? body.map((c: { id: string }) =>
            c.id === "1"
              ? { jsonrpc: "2.0", id: c.id, error: { code: -32429, message: "rate limited" } }
              : { jsonrpc: "2.0", id: c.id, result: { slot: 1 } },
          )
        : { jsonrpc: "2.0", id: 1, result: { slot: 2 } },
    );
    const rpc = new SolanaRpc({ rpcUrl: url });
    const out = await rpc.getParsedTransactions(["a", "b", "c"]);
    expect(out.get("a")).toEqual({ slot: 1 });
    expect(out.get("b")).toEqual({ slot: 2 });
    expect(out.get("c")).toEqual({ slot: 1 });
    expect(rpc.takeCallStats()).toEqual({ getTransaction: 4 });
    expect(rpc.takeLastError()).toContain("rate limited");
    expect(rpc.takeLastError()).toBeNull();
  });

  it("retries a rate-limited batch one at a time without latching", async () => {
    let batches = 0;
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw);
        res.setHeader("content-type", "application/json");
        if (Array.isArray(body)) {
          batches += 1;
          res.statusCode = 429;
          res.setHeader("retry-after", "0");
          res.end("{}");
          return;
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { slot: 3 } }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const rpc = new SolanaRpc({ rpcUrl: `http://127.0.0.1:${address.port}` });

    const out = await rpc.getParsedTransactions(["a", "b"]);
    expect(out.get("a")).toEqual({ slot: 3 });
    expect(out.get("b")).toEqual({ slot: 3 });
    expect(rpc.takeLastError()).toContain("429");

    // Still tries a batch next time: a 429 says nothing about batching support.
    const before = batches;
    await rpc.getParsedTransactions(["c"]);
    expect(batches).toBeGreaterThan(before);
  });

  it("asks for version 1 transactions, single and batched", async () => {
    const { url, bodies } = await startServer((body) =>
      Array.isArray(body)
        ? body.map((c: { id: string }) => ({ jsonrpc: "2.0", id: c.id, result: { slot: 1 } }))
        : { jsonrpc: "2.0", id: 1, result: { slot: 1 } },
    );
    const rpc = new SolanaRpc({ rpcUrl: url });
    await rpc.getParsedTransaction("a");
    await rpc.getParsedTransactions(["b", "c"]);
    const calls = bodies.flatMap((b) => (Array.isArray(b) ? b : [b])) as {
      params: [string, { maxSupportedTransactionVersion: number }];
    }[];
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.params[1].maxSupportedTransactionVersion).toBe(1);
  });

  it("counts every call inside a working batch", async () => {
    const { url } = await startServer((body) =>
      Array.isArray(body)
        ? body.map((c: { id: string }) => ({ jsonrpc: "2.0", id: c.id, result: { slot: 1 } }))
        : { jsonrpc: "2.0", id: 1, result: [] },
    );
    const rpc = new SolanaRpc({ rpcUrl: url });
    await rpc.getSignaturesForAddress("mint");
    const out = await rpc.getParsedTransactions(["a", "b", "c"]);
    expect([...out.values()].every((tx) => tx !== null)).toBe(true);
    expect(rpc.takeCallStats()).toEqual({ getSignaturesForAddress: 1, getTransaction: 3 });
  });
});
