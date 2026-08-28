import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HeliusClient } from "./helius.js";

/**
 * These run against a real local HTTP server rather than a mocked fetch, so they exercise the
 * actual JSON-RPC batch encoding/decoding path end to end - including the two things most likely
 * to break silently: matching batch responses by id (the spec allows any order) and falling back
 * when getTransactionsForAddress isn't served.
 */
interface RecordedRequest {
  body: unknown;
}

let server: Server | undefined;

async function startServer(
  handler: (calls: { id: string; method: string; params: unknown[] }[]) => unknown,
): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(handler(body)));
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

const SECONDS = 1_700_000_000;

describe("HeliusClient.getEarliestActivityBatch (non-Helius endpoint)", () => {
  it("sends all addresses in a single batched POST", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [{ signature: "s", blockTime: SECONDS }] })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    await client.getEarliestActivityBatch(["a", "b", "c"]);

    expect(requests).toHaveLength(1);
    expect(Array.isArray(requests[0]!.body)).toBe(true);
    expect((requests[0]!.body as unknown[]).length).toBe(3);
  });

  it("matches responses to addresses by id, not by position", async () => {
    const times: Record<string, number> = { a: SECONDS, b: SECONDS + 500, c: SECONDS + 900 };
    const { url } = await startServer((calls) =>
      // Deliberately reversed - the JSON-RPC spec permits any ordering.
      [...calls]
        .reverse()
        .map((c) => ({ jsonrpc: "2.0", id: c.id, result: [{ signature: "s", blockTime: times[c.id] }] })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    const result = await client.getEarliestActivityBatch(["a", "b", "c"]);

    expect(result.get("a")).toEqual({ status: "found", earliestActivityAt: new Date(times.a! * 1000) });
    expect(result.get("b")).toEqual({ status: "found", earliestActivityAt: new Date(times.b! * 1000) });
    expect(result.get("c")).toEqual({ status: "found", earliestActivityAt: new Date(times.c! * 1000) });
  });

  it("takes the OLDEST signature (last element) from the newest-first fallback response", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({
        jsonrpc: "2.0",
        id: c.id,
        result: [
          { signature: "newest", blockTime: SECONDS + 900 },
          { signature: "oldest", blockTime: SECONDS },
        ],
      })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    const result = await client.getEarliestActivityBatch(["a"]);
    expect(result.get("a")).toEqual({ status: "found", earliestActivityAt: new Date(SECONDS * 1000) });
  });

  it("reports indeterminate (not failed) for an address with no signatures", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [] })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getEarliestActivityBatch(["a"])).get("a")).toEqual({ status: "indeterminate" });
  });

  it("asks for a bounded page rather than the method's 1000 maximum", async () => {
    // The answer extracted is only "is the first transaction recent?", and a signature is ~120
    // bytes on the wire - a full 1000 page ran ~120KB per wallet for two fields.
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [{ signature: "s", blockTime: SECONDS }] })),
    );
    const client = new HeliusClient({ rpcUrl: url });
    await client.getEarliestActivityBatch(["a"]);

    const calls = requests[0]!.body as { params: [string, { limit: number }] }[];
    expect(calls[0]!.params[1].limit).toBeLessThanOrEqual(200);
  });

  it("returns a usable upper bound - not a shrug - when the page comes back full", async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      signature: `s${i}`,
      // Newest first; the last entry is as far back as this page reaches.
      blockTime: SECONDS + (200 - i),
    }));
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: fullPage })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getEarliestActivityBatch(["a"])).get("a")).toEqual({
      status: "older-than",
      boundAt: new Date((SECONDS + 1) * 1000),
    });
  });

  it("reports failed (not indeterminate) for a per-entry RPC error", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "boom" } })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getEarliestActivityBatch(["a"])).get("a")).toEqual({ status: "failed" });
  });

  it("reports failed for every address when the whole request errors out", async () => {
    const { url } = await startServer(() => ({ not: "an array" }));
    const client = new HeliusClient({ rpcUrl: url });

    const result = await client.getEarliestActivityBatch(["a", "b"]);
    expect(result.get("a")).toEqual({ status: "failed" });
    expect(result.get("b")).toEqual({ status: "failed" });
  });

  it("dedupes repeated addresses into a single call", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [{ signature: "s", blockTime: SECONDS }] })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    await client.getEarliestActivityBatch(["a", "a", "a"]);
    expect((requests[0]!.body as unknown[]).length).toBe(1);
  });

  it("splits into multiple POSTs beyond the batch size", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [{ signature: "s", blockTime: SECONDS }] })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    const addresses = Array.from({ length: 120 }, (_, i) => `addr${i}`);
    const result = await client.getEarliestActivityBatch(addresses);

    expect(requests.length).toBe(3); // 50 + 50 + 20
    expect(result.size).toBe(120);
  });
});

describe("HeliusClient.getEarliestActivityBatch (Helius endpoint)", () => {
  it("uses getTransactionsForAddress sorted ascending and takes the first row as the earliest", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({
        jsonrpc: "2.0",
        id: c.id,
        result: { data: [{ signature: "first-ever", blockTime: SECONDS }], paginationToken: null },
      })),
    );
    // rpcUrl must contain "helius" for the client to treat this as a Helius endpoint.
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });

    const result = await client.getEarliestActivityBatch(["a"]);

    const calls = requests[0]!.body as { method: string; params: [string, Record<string, unknown>] }[];
    expect(calls[0]!.method).toBe("getTransactionsForAddress");
    expect(calls[0]!.params[1]).toMatchObject({
      sortOrder: "asc",
      limit: 1,
      transactionDetails: "signatures",
    });
    expect(result.get("a")).toEqual({ status: "found", earliestActivityAt: new Date(SECONDS * 1000) });
  });

  it("falls back to getSignaturesForAddress when getTransactionsForAddress isn't served", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => {
        const method = (c as { method: string }).method;
        if (method === "getTransactionsForAddress") {
          return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "Method not found" } };
        }
        return { jsonrpc: "2.0", id: c.id, result: [{ signature: "s", blockTime: SECONDS }] };
      }),
    );
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });

    const result = await client.getEarliestActivityBatch(["a"]);

    const methods = requests.map((r) => (r.body as { method: string }[])[0]!.method);
    expect(methods).toEqual(["getTransactionsForAddress", "getSignaturesForAddress"]);
    expect(result.get("a")).toEqual({ status: "found", earliestActivityAt: new Date(SECONDS * 1000) });
  });

  it("falls back when the endpoint rejects the method at the HTTP level, not as a JSON-RPC error", async () => {
    // The bug this covers: the fallback used to trigger ONLY on a -32601 error object. An
    // endpoint that answers an unknown method with a 4xx instead produced an all-failed map that
    // was returned as the result - the signatures path was never reached, wallet freshness was
    // permanently null, and a wasted batch was re-sent every cycle looking like a blip.
    let sawGtfa = false;
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const calls = JSON.parse(raw) as { id: string; method: string }[];
        if (calls[0]!.method === "getTransactionsForAddress") {
          sawGtfa = true;
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "unsupported method" }));
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            calls.map((c) => ({
              jsonrpc: "2.0",
              id: c.id,
              result: [{ signature: "s", blockTime: SECONDS }],
            })),
          ),
        );
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
    const client = new HeliusClient({ rpcUrl: `http://127.0.0.1:${address.port}/?helius=1` });

    const result = await client.getEarliestActivityBatch(["a"]);

    expect(sawGtfa).toBe(true);
    expect(result.get("a")).toEqual({ status: "found", earliestActivityAt: new Date(SECONDS * 1000) });
  });

  it("keeps trying the Helius path through a brief outage, then latches if it stays barren", async () => {
    // A round where everything fails is ambiguous - an unsupported method and a total outage look
    // identical - so it must not latch on the first one, or an outage would permanently downgrade
    // a healthy deployment until restart.
    let failGtfa = true;
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => {
        const method = (c as { method: string }).method;
        if (method === "getTransactionsForAddress") {
          return failGtfa
            ? { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "upstream unavailable" } }
            : { jsonrpc: "2.0", id: c.id, result: { data: [{ signature: "f", blockTime: SECONDS }] } };
        }
        return { jsonrpc: "2.0", id: c.id, result: [{ signature: "s", blockTime: SECONDS }] };
      }),
    );
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });

    await client.getEarliestActivityBatch(["a"]);
    expect(client.earliestActivityMethod).toBe("getTransactionsForAddress"); // one bad round is not a verdict

    failGtfa = false;
    requests.length = 0;
    const recovered = await client.getEarliestActivityBatch(["b"]);
    expect((requests[0]!.body as { method: string }[])[0]!.method).toBe("getTransactionsForAddress");
    expect(recovered.get("b")).toEqual({ status: "found", earliestActivityAt: new Date(SECONDS * 1000) });

    // Now let it stay broken for the full latch threshold.
    failGtfa = true;
    for (let i = 0; i < 3; i++) await client.getEarliestActivityBatch([`c${i}`]);
    expect(client.earliestActivityMethod).toBe("getSignaturesForAddress");

    requests.length = 0;
    await client.getEarliestActivityBatch(["d"]);
    expect((requests[0]!.body as { method: string }[])[0]!.method).toBe("getSignaturesForAddress");
  });

  it("latches the fallback so later batches skip getTransactionsForAddress entirely", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => {
        const method = (c as { method: string }).method;
        if (method === "getTransactionsForAddress") {
          return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "Method not found" } };
        }
        return { jsonrpc: "2.0", id: c.id, result: [{ signature: "s", blockTime: SECONDS }] };
      }),
    );
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });

    await client.getEarliestActivityBatch(["a"]);
    requests.length = 0;
    await client.getEarliestActivityBatch(["b"]);

    const methods = requests.map((r) => (r.body as { method: string }[])[0]!.method);
    expect(methods).toEqual(["getSignaturesForAddress"]);
  });
});

describe("HeliusClient.getMintAuthorityStatusBatch", () => {
  function accountInfoResponse(mintAuthority: string | null, freezeAuthority: string | null) {
    return { value: { data: { parsed: { info: { mintAuthority, freezeAuthority } } } } };
  }

  it("reports both authorities from a batched getAccountInfo", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: accountInfoResponse("someAuthority", null) })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMintAuthorityStatusBatch(["m"])).get("m")).toEqual({
      status: "found",
      mintAuthorityActive: true,
      freezeAuthorityActive: false,
    });
  });

  it("reports revoked authorities as inactive", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: accountInfoResponse(null, null) })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMintAuthorityStatusBatch(["m"])).get("m")).toEqual({
      status: "found",
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
    });
  });

  it("reports failed - never a fabricated all-clear - for an unparseable account", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: { value: null } })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMintAuthorityStatusBatch(["m"])).get("m")).toEqual({ status: "failed" });
  });
});

describe("HeliusClient.getMayhemModeBatch", () => {
  const MAYHEM_MINT = "GuYxhafeew241DThgKquTXEEBpt8FRPdRq6xfstdpump";
  const OTHER_MINT = "3jNd8LdRvzCKBdWevmaqdDfqGk7op8GqkXnb3qVBpump";

  it("reports isMayhemMode when the mayhem-state PDA exists", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({
        jsonrpc: "2.0",
        id: c.id,
        result: { value: { data: ["", "base64"], owner: "x" } },
      })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMayhemModeBatch([MAYHEM_MINT])).get(MAYHEM_MINT)).toEqual({
      status: "found",
      isMayhemMode: true,
    });
  });

  it("reports NOT mayhem when the account does not exist", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: { value: null } })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMayhemModeBatch([OTHER_MINT])).get(OTHER_MINT)).toEqual({
      status: "found",
      isMayhemMode: false,
    });
  });

  it("queries the derived mayhem-state PDA, not the mint itself", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: { value: null } })),
    );
    const client = new HeliusClient({ rpcUrl: url });
    await client.getMayhemModeBatch([MAYHEM_MINT]);

    const calls = requests[0]!.body as { id: string; params: [string, unknown] }[];
    expect(calls[0]!.id).toBe(MAYHEM_MINT); // response keyed back to the mint
    expect(calls[0]!.params[0]).toBe("HmT6rHQvnpx8nk6WqtZbzeThLmSwhsZQUJeVoEdWJWTr"); // but queried by PDA
  });

  it("reports failed - never a false all-clear - when the lookup errors", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "boom" } })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMayhemModeBatch([MAYHEM_MINT])).get(MAYHEM_MINT)).toEqual({ status: "failed" });
  });

  it("batches every mint into one POST and dedupes", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: { value: null } })),
    );
    const client = new HeliusClient({ rpcUrl: url });
    const result = await client.getMayhemModeBatch([MAYHEM_MINT, OTHER_MINT, MAYHEM_MINT]);

    expect(requests).toHaveLength(1);
    expect((requests[0]!.body as unknown[]).length).toBe(2);
    expect(result.size).toBe(2);
  });
});

describe("HeliusClient call accounting", () => {
  it("counts RPC method invocations, not HTTP requests - the number a plan bills on", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [{ signature: "s", blockTime: SECONDS }] })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    await client.getEarliestActivityBatch(Array.from({ length: 60 }, (_, i) => `a${i}`));

    // Two POSTs (50 + 10), but sixty billable calls - the whole point of measuring here.
    expect(requests).toHaveLength(2);
    expect(client.takeCallStats()).toEqual({ getSignaturesForAddress: 60 });
    // Reads reset, so each cycle reports its own spend.
    expect(client.takeCallStats()).toEqual({});
  });

  it("counts a batch that failed in transit - the attempt was still spent", async () => {
    const { url } = await startServer(() => ({ not: "an array" }));
    const client = new HeliusClient({ rpcUrl: url });

    await client.getEarliestActivityBatch(["a", "b"]);
    expect(client.takeCallStats()).toEqual({ getSignaturesForAddress: 2 });
  });

  it("honours an explicit isHelius flag for a proxied endpoint the URL can't reveal", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: { data: [{ blockTime: SECONDS }] } })),
    );
    const client = new HeliusClient({ rpcUrl: url, isHelius: true });
    await client.getEarliestActivityBatch(["a"]);

    expect((requests[0]!.body as { method: string }[])[0]!.method).toBe("getTransactionsForAddress");
  });
});
