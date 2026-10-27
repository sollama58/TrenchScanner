import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityStretch, HeliusClient, resetRpcPauses, WALLET_DORMANT_GAP_MS } from "./helius.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { mayhemStateAddress, metaplexMetadataAddress } from "../solana.js";
import { STONKS_FEE_WALLET } from "../stonksFees.js";
import {
  CPMM_LP_READ_BYTES,
  LAUNCHLAB_PROGRAM,
  RAYDIUM_CPMM_LOCK_AUTHORITY,
  RAYDIUM_CPMM_PROGRAM,
  launchLabPoolOf,
} from "./launchLab.js";

const WALLET = bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
const CURVE = mayhemStateAddress(WALLET);
const OTHER = bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(9)));

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
      const reply = handler(body);
      if (reply && typeof reply === "object" && "__status" in reply) {
        res.statusCode = (reply as { __status: number }).__status;
        res.end("{}");
        return;
      }
      res.end(JSON.stringify(reply));
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

    expect(result.get("a")).toMatchObject({ status: "found", earliestActivityAt: new Date(times.a! * 1000) });
    expect(result.get("b")).toMatchObject({ status: "found", earliestActivityAt: new Date(times.b! * 1000) });
    expect(result.get("c")).toMatchObject({ status: "found", earliestActivityAt: new Date(times.c! * 1000) });
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
    expect(result.get("a")).toMatchObject({ status: "found", earliestActivityAt: new Date(SECONDS * 1000) });
  });

  it("reports indeterminate (not failed) for an address with no signatures", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [] })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getEarliestActivityBatch(["a"])).get("a")).toEqual({ status: "indeterminate" });
  });

  it("reads the funders' 1000 page but answers from its first 200 rows, as the 200 page did", async () => {
    // One page shared with the funder read (Helius audit 2026-10-23, N-1). A wallet with 500
    // signatures is still a full 200 page: bounded at its 200th newest, not exact at its 500th.
    const page = Array.from({ length: 500 }, (_, i) => ({
      signature: `s${i}`,
      blockTime: SECONDS + 500 - i,
    }));
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({
        jsonrpc: "2.0",
        id: c.id,
        result: page.slice(0, (c.params[1] as { limit: number }).limit),
      })),
    );
    const client = new HeliusClient({ rpcUrl: url });
    const result = await client.getEarliestActivityBatch(["a"]);

    const calls = requests[0]!.body as { params: [string, { limit: number }] }[];
    expect(calls[0]!.params[1]).toEqual({ limit: 1000 });
    expect(result.get("a")).toEqual({
      status: "older-than",
      boundAt: new Date((SECONDS + 301) * 1000),
      lastActivityAt: new Date((SECONDS + 500) * 1000),
    });
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

    expect((await client.getEarliestActivityBatch(["a"])).get("a")).toMatchObject({
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
    expect(result.get("a")).toMatchObject({ status: "found", earliestActivityAt: new Date(SECONDS * 1000) });
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
    expect(result.get("a")).toMatchObject({ status: "found", earliestActivityAt: new Date(SECONDS * 1000) });
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
    expect(result.get("a")).toMatchObject({ status: "found", earliestActivityAt: new Date(SECONDS * 1000) });
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
    expect(recovered.get("b")).toMatchObject({
      status: "found",
      earliestActivityAt: new Date(SECONDS * 1000),
    });

    // Now let it stay broken for the full latch threshold.
    failGtfa = true;
    for (let i = 0; i < 3; i++) await client.getEarliestActivityBatch([`c${i}`]);
    expect(client.earliestActivityMethod).toBe("getSignaturesForAddress");

    requests.length = 0;
    await client.getEarliestActivityBatch(["d"]);
    expect((requests[0]!.body as { method: string }[])[0]!.method).toBe("getSignaturesForAddress");
    // The launch-buyers read rides on the same method and stands down with it.
    expect((await client.getLaunchBuyersBatch(["m"], 25)).get("m")).toEqual({ status: "unsupported" });

    // Stood down, not switched off: a bad minute at Helius is not a fact about the plan. Ten
    // minutes on, both reads try the method again - and it answers.
    failGtfa = false;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60_000);
    try {
      expect(client.earliestActivityMethod).toBe("getTransactionsForAddress");
      requests.length = 0;
      const back = await client.getEarliestActivityBatch(["e"]);
      expect((requests[0]!.body as { method: string }[])[0]!.method).toBe("getTransactionsForAddress");
      expect(back.get("e")).toMatchObject({ status: "found", earliestActivityAt: new Date(SECONDS * 1000) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not count a round nobody answered against the latch", async () => {
    // A timeout or a 5xx on the whole batch says nothing about whether the plan serves the method.
    let down = true;
    const { url } = await startServer((calls) => {
      if (down) return { __status: 502 };
      return calls.map((c) => ({
        jsonrpc: "2.0",
        id: c.id,
        result: { data: [{ signature: "f", blockTime: SECONDS }] },
      }));
    });
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });
    for (let i = 0; i < 3; i++) await client.getEarliestActivityBatch([`a${i}`]);
    expect(client.earliestActivityMethod).toBe("getTransactionsForAddress");
    down = false;
    const result = await client.getEarliestActivityBatch(["b"]);
    expect(result.get("b")).toMatchObject({ status: "found", earliestActivityAt: new Date(SECONDS * 1000) });
  }, 30_000);

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

/** Answers every getMultipleAccounts call by mapping each requested key through `account`. */
function gmaServer(account: (key: string) => unknown) {
  return startServer((calls) =>
    calls.map((c) => ({
      jsonrpc: "2.0",
      id: c.id,
      result: { context: { slot: 1 }, value: (c.params[0] as string[]).map(account) },
    })),
  );
}

describe("HeliusClient.getEarliestActivityBatch with boundSufficientBefore", () => {
  it("settles what one signatures page can, and pays for getTransactionsForAddress only for the rest", async () => {
    // getSignaturesForAddress is 1 credit, getTransactionsForAddress 10: a short history ("new")
    // or a full page reaching past the cutoff ("old") needs nothing more; only a busy wallet whose
    // full page sits entirely inside the window ("busy") does.
    const cutoff = SECONDS;
    const page = (blockTime: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ signature: `s${i}`, blockTime }));
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => {
        const address = c.params[0] as string;
        if (c.method === "getTransactionsForAddress") {
          return {
            jsonrpc: "2.0",
            id: c.id,
            result: { data: [{ signature: "first", blockTime: cutoff - 5 }] },
          };
        }
        const result =
          address === "new"
            ? page(cutoff + 60, 3)
            : address === "old"
              ? page(cutoff - 60, 200)
              : page(cutoff + 60, 200);
        return { jsonrpc: "2.0", id: c.id, result };
      }),
    );
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });

    const result = await client.getEarliestActivityBatch(["new", "old", "busy"], {
      boundSufficientBefore: new Date(cutoff * 1000),
    });

    const sent = requests.flatMap((r) =>
      (r.body as { method: string; params: [string] }[]).map((c) => [c.method, c.params[0]]),
    );
    expect(sent.filter(([m]) => m === "getTransactionsForAddress")).toEqual([
      ["getTransactionsForAddress", "busy"],
    ]);
    expect(result.get("new")).toMatchObject({
      status: "found",
      earliestActivityAt: new Date((cutoff + 60) * 1000),
    });
    expect(result.get("old")).toMatchObject({
      status: "older-than",
      boundAt: new Date((cutoff - 60) * 1000),
    });
    expect(result.get("busy")).toMatchObject({
      status: "found",
      earliestActivityAt: new Date((cutoff - 5) * 1000),
    });
  });
});

describe("HeliusClient.getEarliestActivityBatch when the exact lookup fails", () => {
  it("reports a busy wallet as failed, never as its in-window bound", async () => {
    // The bound only says "busy"; passed on, the caller cached the wallet as not fresh for good.
    const cutoff = SECONDS;
    const { url } = await startServer((calls) =>
      calls.map((c) =>
        c.method === "getTransactionsForAddress"
          ? { jsonrpc: "2.0", id: c.id, error: { code: -32429, message: "rate limited" } }
          : {
              jsonrpc: "2.0",
              id: c.id,
              result: Array.from({ length: 200 }, (_, i) => ({ signature: `s${i}`, blockTime: cutoff + 60 })),
            },
      ),
    );
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });

    const result = await client.getEarliestActivityBatch(["busy"], {
      boundSufficientBefore: new Date(cutoff * 1000),
    });

    expect(result.get("busy")).toEqual({ status: "failed" });
  });
});

describe("HeliusClient.getEarliestActivityBatch when the cheap lookup fails", () => {
  it("leaves the wallet failed rather than paying for getTransactionsForAddress", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "busy" } })),
    );
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });

    const result = await client.getEarliestActivityBatch(["a", "b"], {
      boundSufficientBefore: new Date(SECONDS * 1000),
    });

    const methods = requests.flatMap((r) => (r.body as { method: string }[]).map((c) => c.method));
    expect(methods).not.toContain("getTransactionsForAddress");
    expect(result.get("a")).toEqual({ status: "failed" });
    expect(result.get("b")).toEqual({ status: "failed" });
  });
});

describe("HeliusClient.getNativeSolLamports", () => {
  it("reads lamports with one getMultipleAccounts and returns null for a missing account", async () => {
    const { url, requests } = await gmaServer((key) =>
      key === "gone" ? null : { lamports: key === "empty" ? 0 : 1_500_000_000 },
    );
    const client = new HeliusClient({ rpcUrl: url });
    const got = await client.getNativeSolLamports(["rich", "gone", "empty", "rich"]);
    expect(got.get("rich")).toBe(1_500_000_000);
    expect(got.get("gone")).toBeNull();
    expect(got.get("empty")).toBe(0);
    expect(requests).toHaveLength(1);
    const call = (
      requests[0]!.body as {
        method: string;
        params: [
          string[],
          { encoding?: string; commitment?: string; dataSlice?: { offset: number; length: number } },
        ];
      }[]
    )[0]!;
    expect(call.method).toBe("getMultipleAccounts");
    expect(call.params[0]).toEqual(["rich", "gone", "empty"]);
    expect(call.params[1]).toMatchObject({
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: { offset: 0, length: 0 },
    });
  });
});

describe("HeliusClient.getMetadataUris", () => {
  const key = (n: number) => bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) % 256));
  const classic = key(1);
  const token2022 = key(2);
  const bare = key(3);
  const gone = key(4);
  const uri = "https://ipfs.io/ipfs/" + "Q".repeat(46);

  /** A MetadataV1 account: key, update authority, mint, then name, symbol, uri padded with NULs. */
  function metaplexAccount(u: string): { data: [string, "base64"] } {
    const str = (text: string, pad: number) => {
      const bytes = Buffer.alloc(pad);
      bytes.write(text);
      const len = Buffer.alloc(4);
      len.writeUInt32LE(pad);
      return Buffer.concat([len, bytes]);
    };
    const body = Buffer.concat([
      Buffer.from([4]),
      Buffer.alloc(64),
      str("Coin", 32),
      str("C", 10),
      str(u, 200),
    ]);
    return { data: [body.toString("base64"), "base64"] };
  }
  const parsedMint = (extensions?: unknown[]) => ({
    data: {
      parsed: { type: "mint", info: { supply: "1", decimals: 6, ...(extensions ? { extensions } : {}) } },
    },
  });

  it("reads classic and Token-2022 URIs off the chain in one 1-credit call (audit 2026-10-27, DA-4)", async () => {
    const { url, requests } = await gmaServer((address) => {
      if (address === classic || address === bare) return parsedMint();
      if (address === token2022)
        return parsedMint([{ extension: "tokenMetadata", state: { name: "T", uri: ` ${uri} ` } }]);
      if (address === metaplexMetadataAddress(classic)) return metaplexAccount(uri);
      return null;
    });
    const client = new HeliusClient({ rpcUrl: url });
    const got = await client.getMetadataUris([classic, token2022, bare, gone, classic]);
    expect(got.get(classic)).toBe(uri);
    expect(got.get(token2022)).toBe(uri);
    // The mint is there and nothing names a URI: a settled "none".
    expect(got.get(bare)).toBeNull();
    // Not at "confirmed" yet: asked again later.
    expect(got.get(gone)).toBe("failed");
    expect(requests).toHaveLength(1);
    expect(client.takeCallStats()).toEqual({ getMultipleAccounts: 1 });
    const call = (requests[0]!.body as { method: string; params: [string[], { encoding: string }] }[])[0]!;
    expect(call.params[0]).toHaveLength(8);
    expect(call.params[1].encoding).toBe("jsonParsed");
  });

  it("is failed for every mint when the read got no answer", async () => {
    const { url } = await startServer(() => ({
      jsonrpc: "2.0",
      id: "x",
      error: { code: -32000, message: "no" },
    }));
    const got = await new HeliusClient({ rpcUrl: url }).getMetadataUris([classic, token2022]);
    expect([...got.values()]).toEqual(["failed", "failed"]);
  });
});

describe("HeliusClient.getMintAuthorityStatusBatch", () => {
  function mintAccount(mintAuthority: string | null, freezeAuthority: string | null) {
    return { data: { parsed: { info: { mintAuthority, freezeAuthority } } } };
  }

  it("reports both authorities from one getMultipleAccounts call at confirmed", async () => {
    const { url, requests } = await gmaServer(() => mintAccount("someAuthority", null));
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMintAuthorityStatusBatch(["m"])).get("m")).toEqual({
      status: "found",
      mintAuthorityActive: true,
      freezeAuthorityActive: false,
    });
    const call = (requests[0]!.body as { method: string; params: [string[], { commitment: string }] }[])[0]!;
    expect(call.method).toBe("getMultipleAccounts");
    expect(call.params[1].commitment).toBe("confirmed");
  });

  it("reports revoked authorities as inactive", async () => {
    const { url } = await gmaServer(() => mintAccount(null, null));
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMintAuthorityStatusBatch(["m"])).get("m")).toEqual({
      status: "found",
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
    });
  });

  it("reports failed - never a fabricated all-clear - for a missing or unparseable account", async () => {
    const { url } = await gmaServer((key) => (key === "gone" ? null : { data: ["", "base64"] }));
    const client = new HeliusClient({ rpcUrl: url });
    const result = await client.getMintAuthorityStatusBatch(["gone", "raw"]);

    expect(result.get("gone")).toEqual({ status: "failed" });
    expect(result.get("raw")).toEqual({ status: "failed" });
  });

  it("bills one call per 100 mints instead of one per mint", async () => {
    const { url } = await gmaServer(() => mintAccount(null, null));
    const client = new HeliusClient({ rpcUrl: url });
    const result = await client.getMintAuthorityStatusBatch(Array.from({ length: 150 }, (_, i) => `m${i}`));

    expect(result.size).toBe(150);
    expect([...result.values()].every((r) => r.status === "found")).toBe(true);
    expect(client.takeCallStats()).toEqual({ getMultipleAccounts: 2 });
  });

  it("fails the whole chunk when the reply's value array doesn't line up with the keys", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: { value: [mintAccount(null, null)] } })),
    );
    const client = new HeliusClient({ rpcUrl: url });
    const result = await client.getMintAuthorityStatusBatch(["a", "b"]);

    expect(result.get("a")).toEqual({ status: "failed" });
    expect(result.get("b")).toEqual({ status: "failed" });
  });
});

describe("HeliusClient 429 pause", () => {
  it("holds every client on the same endpoint after a 429, not just the request that got it", async () => {
    // A shorter floor than HELIUS_MIN_PAUSE_MS, so the test doesn't wait 5 s; it is still the floor.
    resetRpcPauses({ minPauseMs: 400 });
    const arrivals: number[] = [];
    let limitedAt = 0;
    let started: Promise<unknown> | undefined;
    let url = "";
    ({ url } = await startServer((calls) => {
      arrivals.push(Date.now());
      if (arrivals.length === 1) {
        limitedAt = Date.now();
        // Another job's client asks the same endpoint a moment after the 429.
        started = new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
          new HeliusClient({ rpcUrl: url }).getMintAuthorityStatusBatch(["b"]),
        );
        return { __status: 429 };
      }
      return calls.map((c) => ({
        jsonrpc: "2.0",
        id: c.id,
        result: {
          context: { slot: 1 },
          value: (c.params[0] as string[]).map(() => ({
            data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } },
          })),
        },
      }));
    }));
    const first = await new HeliusClient({ rpcUrl: url }).getMintAuthorityStatusBatch(["a"]);
    expect(first.get("a")?.status).toBe("found");
    const second = (await started) as Map<string, { status: string }>;
    expect(second.get("b")?.status).toBe("found");
    // The pause's floor, not fetchJson's 250-750 ms backoff: neither later request went out inside it.
    expect(arrivals).toHaveLength(3);
    for (const at of arrivals.slice(1)) expect(at - limitedAt).toBeGreaterThanOrEqual(390);
    resetRpcPauses();
  });
});

describe("HeliusClient.getMayhemModeBatch", () => {
  const MAYHEM_MINT = "GuYxhafeew241DThgKquTXEEBpt8FRPdRq6xfstdpump";
  const MAYHEM_PDA = "HmT6rHQvnpx8nk6WqtZbzeThLmSwhsZQUJeVoEdWJWTr";
  const OTHER_MINT = "3jNd8LdRvzCKBdWevmaqdDfqGk7op8GqkXnb3qVBpump";
  const exists = { data: ["", "base64"], owner: "x" };

  it("reports isMayhemMode when the mayhem-state PDA exists", async () => {
    const { url } = await gmaServer(() => exists);
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMayhemModeBatch([MAYHEM_MINT])).get(MAYHEM_MINT)).toEqual({
      status: "found",
      isMayhemMode: true,
    });
  });

  it("reports NOT mayhem when the mint exists but its PDA does not", async () => {
    const { url } = await gmaServer((key) => (key === OTHER_MINT ? exists : null));
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMayhemModeBatch([OTHER_MINT])).get(OTHER_MINT)).toEqual({
      status: "found",
      isMayhemMode: false,
    });
  });

  it("reports failed - not a cacheable false - when the mint itself isn't visible yet", async () => {
    const { url } = await gmaServer(() => null);
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMayhemModeBatch([OTHER_MINT])).get(OTHER_MINT)).toEqual({
      status: "failed",
      mintPending: true,
    });
  });

  it("queries the mint and its derived PDA in one call, without account data", async () => {
    const { url, requests } = await gmaServer(() => null);
    const client = new HeliusClient({ rpcUrl: url });
    await client.getMayhemModeBatch([MAYHEM_MINT]);

    const calls = requests[0]!.body as { params: [string[], { dataSlice: unknown }] }[];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params[0]).toEqual([MAYHEM_MINT, MAYHEM_PDA]);
    expect(calls[0]!.params[1].dataSlice).toEqual({ offset: 0, length: 0 });
  });

  it("reports failed - never a false all-clear - when the lookup errors", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "boom" } })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMayhemModeBatch([MAYHEM_MINT])).get(MAYHEM_MINT)).toEqual({ status: "failed" });
  });

  it("reports failed for a reply with no value array", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: {} })),
    );
    const client = new HeliusClient({ rpcUrl: url });

    expect((await client.getMayhemModeBatch([MAYHEM_MINT])).get(MAYHEM_MINT)).toEqual({ status: "failed" });
  });

  it("dedupes mints and spends a single call", async () => {
    const { url, requests } = await gmaServer(() => null);
    const client = new HeliusClient({ rpcUrl: url });
    const result = await client.getMayhemModeBatch([MAYHEM_MINT, OTHER_MINT, MAYHEM_MINT]);

    expect(requests).toHaveLength(1);
    expect(client.takeCallStats()).toEqual({ getMultipleAccounts: 1 });
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

describe("HeliusClient.getLaunchBuyersBatch", () => {
  it("sends each mint's read as its own request, so one heavy answer can't fail the rest", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: { data: [], paginationToken: null } })),
    );
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });
    const out = await client.getLaunchBuyersBatch(["m1", "m2", "m3"], 25);
    expect(requests).toHaveLength(3);
    for (const r of requests) expect(r.body as unknown[]).toHaveLength(1);
    // An empty history is a mint too new for the index: retried, not answered.
    expect(out.get("m2")).toEqual({ status: "failed" });
  });
});

describe("HeliusClient.getLargestHoldersBatch", () => {
  it("reads the largest accounts and supply, then each account's owner", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        if (c.method === "getTokenLargestAccounts")
          return {
            jsonrpc: "2.0",
            id: c.id,
            result: {
              value: [
                { address: "acct1", amount: "600" },
                { address: "acct2", amount: "100" },
              ],
            },
          };
        if (c.method === "getTokenSupply")
          return { jsonrpc: "2.0", id: c.id, result: { value: { amount: "1000" } } };
        // getMultipleAccounts: the first account belongs to a program address, the second to a wallet.
        return {
          jsonrpc: "2.0",
          id: c.id,
          result: {
            value: [
              { data: { parsed: { info: { owner: CURVE } } } },
              { data: { parsed: { info: { owner: WALLET } } } },
            ],
          },
        };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url });
    const result = await client.getLargestHoldersBatch(["mintA"]);
    expect(result.get("mintA")).toEqual({
      status: "found",
      holders: {
        top10HolderPct: 10,
        largestHolderPct: 10,
        top10HolderAddresses: [WALLET],
        topHolderShares: [{ owner: WALLET, pct: 10 }],
      },
    });
  });

  it("fails a mint whose reads came back without an answer", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "busy" } })),
    );
    const client = new HeliusClient({ rpcUrl: url });
    expect((await client.getLargestHoldersBatch(["mintA"])).get("mintA")).toEqual({ status: "failed" });
  });

  it("leaves Stonks' fee wallet out of any coin's holders", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        if (c.method === "getTokenLargestAccounts")
          return {
            jsonrpc: "2.0",
            id: c.id,
            result: {
              value: [
                { address: "acct1", amount: "300" },
                { address: "acct2", amount: "100" },
              ],
            },
          };
        if (c.method === "getTokenSupply")
          return { jsonrpc: "2.0", id: c.id, result: { value: { amount: "1000" } } };
        return {
          jsonrpc: "2.0",
          id: c.id,
          result: {
            value: [
              { data: { parsed: { info: { owner: STONKS_FEE_WALLET } } } },
              { data: { parsed: { info: { owner: WALLET } } } },
            ],
          },
        };
      }),
    );
    const result = await new HeliusClient({ rpcUrl: url }).getLargestHoldersBatch(["mintA"]);
    expect(result.get("mintA")).toEqual({
      status: "found",
      holders: {
        top10HolderPct: 10,
        largestHolderPct: 10,
        top10HolderAddresses: [WALLET],
        topHolderShares: [{ owner: WALLET, pct: 10 }],
      },
    });
  });
});

describe("HeliusClient.getTopHoldersBatch", () => {
  const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const row = (owner: string, amount: bigint) => {
    const bytes = Buffer.alloc(40);
    Buffer.from(bs58.decode(owner)).copy(bytes, 0);
    bytes.writeBigUInt64LE(amount, 32);
    return { pubkey: `acct-${owner}`, account: { data: [bytes.toString("base64"), "base64"] } };
  };

  const mintAccount = (c: { id: string }) => ({
    jsonrpc: "2.0",
    id: c.id,
    result: {
      value: [
        {
          owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
          data: { parsed: { info: { supply: "1000" } } },
        },
      ],
    },
  });

  it("reads every account of the mint under its program, one 1-credit V2 page, and keeps the largest wallets", async () => {
    const seen: { method: string; params: unknown[] }[] = [];
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        seen.push({ method: c.method, params: c.params });
        if (c.method === "getMultipleAccounts") return mintAccount(c);
        return {
          jsonrpc: "2.0",
          id: c.id,
          result: { accounts: [row(CURVE, 800n), row(WALLET, 150n)], paginationKey: null },
        };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url, isHelius: true });
    const result = await client.getTopHoldersBatch(["mintA"], 25);
    expect(result.get("mintA")).toEqual({
      status: "found",
      supply: "1000",
      holders: [{ owner: WALLET, pct: 15, accounts: [`acct-${WALLET}`] }],
    });
    expect(seen.map((c) => c.method)).toEqual(["getMultipleAccounts", "getProgramAccountsV2"]);
    const gpa = seen.find((c) => c.method === "getProgramAccountsV2")!;
    expect(gpa.params[0]).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    expect(gpa.params[1]).toMatchObject({
      limit: 10_000,
      dataSlice: { offset: 32, length: 40 },
      filters: [{ memcmp: { offset: 0, bytes: "mintA" } }],
    });
    expect(gpa.params[1]).not.toHaveProperty("paginationKey");
  });

  it("follows the V2 pagination key until the last page, and gives up on a mint that errors mid-walk", async () => {
    const seen: { method: string; params: unknown[] }[] = [];
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        seen.push({ method: c.method, params: c.params });
        if (c.method === "getMultipleAccounts") return mintAccount(c);
        const key = (c.params[1] as { paginationKey?: string }).paginationKey;
        if (key === "page2") return { jsonrpc: "2.0", id: c.id, result: { accounts: [row(WALLET, 150n)] } };
        return {
          jsonrpc: "2.0",
          id: c.id,
          result: { accounts: [row(CURVE, 800n), row(OTHER, 20n)], paginationKey: "page2" },
        };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url, isHelius: true });
    const result = await client.getTopHoldersBatch(["mintA"], 25);
    expect(result.get("mintA")).toEqual({
      status: "found",
      supply: "1000",
      holders: [
        { owner: WALLET, pct: 15, accounts: [`acct-${WALLET}`] },
        { owner: OTHER, pct: 2, accounts: [`acct-${OTHER}`] },
      ],
    });
    expect(seen.filter((c) => c.method === "getProgramAccountsV2")).toHaveLength(2);

    const failing = await startServer((calls) =>
      calls.map((c) => {
        if (c.method === "getMultipleAccounts") return mintAccount(c);
        const key = (c.params[1] as { paginationKey?: string }).paginationKey;
        if (key === "page2") return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "busy" } };
        return { jsonrpc: "2.0", id: c.id, result: { accounts: [row(CURVE, 800n)], paginationKey: "page2" } };
      }),
    );
    const partial = new HeliusClient({ rpcUrl: failing.url, isHelius: true });
    expect((await partial.getTopHoldersBatch(["mintA"], 25)).get("mintA")).toEqual({
      status: "failed",
      reason: "token accounts unreadable (getProgramAccountsV2: busy)",
    });
  });

  it("reads a mint unpaged when V2 finds no accounts for it, without giving V2 up", async () => {
    const seen: string[] = [];
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        seen.push(c.method);
        if (c.method === "getMultipleAccounts") return mintAccount(c);
        if (c.method === "getProgramAccountsV2")
          return { jsonrpc: "2.0", id: c.id, result: { accounts: [], paginationKey: null } };
        return { jsonrpc: "2.0", id: c.id, result: [row(CURVE, 800n), row(WALLET, 150n)] };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url, isHelius: true });
    expect((await client.getTopHoldersBatch(["mintA"], 25)).get("mintA")).toEqual({
      status: "found",
      supply: "1000",
      holders: [{ owner: WALLET, pct: 15, accounts: [`acct-${WALLET}`] }],
    });
    await client.getTopHoldersBatch(["mintA"], 25);
    expect(seen.filter((m) => m === "getProgramAccountsV2")).toHaveLength(2);
    expect(seen.filter((m) => m === "getProgramAccounts")).toHaveLength(2);
  });

  it("reads a mint unpaged when V2 refuses it with an error, and names a read that still fails", async () => {
    let unpaged = 0;
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        if (c.method === "getMultipleAccounts") return mintAccount(c);
        if (c.method === "getProgramAccountsV2")
          return { jsonrpc: "2.0", id: c.id, error: { code: -32602, message: "refused" } };
        unpaged += 1;
        return unpaged === 1
          ? { jsonrpc: "2.0", id: c.id, result: [row(CURVE, 800n), row(WALLET, 150n)] }
          : { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "busy" } };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url, isHelius: true });
    expect((await client.getTopHoldersBatch(["mintA"], 25)).get("mintA")).toEqual({
      status: "found",
      supply: "1000",
      holders: [{ owner: WALLET, pct: 15, accounts: [`acct-${WALLET}`] }],
    });
    expect((await client.getTopHoldersBatch(["mintA"], 25)).get("mintA")).toEqual({
      status: "failed",
      reason: "token accounts unreadable (getProgramAccounts: busy)",
    });
  });

  it("falls back to the unpaged getProgramAccounts for good when the endpoint doesn't serve V2", async () => {
    const seen: string[] = [];
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        seen.push(c.method);
        if (c.method === "getMultipleAccounts") return mintAccount(c);
        if (c.method === "getProgramAccountsV2")
          return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "Method not found" } };
        return { jsonrpc: "2.0", id: c.id, result: [row(CURVE, 800n), row(WALLET, 150n)] };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url, isHelius: true });
    expect((await client.getTopHoldersBatch(["mintA"], 25)).get("mintA")).toEqual({
      status: "found",
      supply: "1000",
      holders: [{ owner: WALLET, pct: 15, accounts: [`acct-${WALLET}`] }],
    });
    expect((await client.getTopHoldersBatch(["mintA"], 25)).get("mintA")?.status).toBe("found");
    expect(seen.filter((m) => m === "getProgramAccountsV2")).toHaveLength(1);
    expect(seen.filter((m) => m === "getProgramAccounts")).toHaveLength(2);
  });

  it("uses the unpaged getProgramAccounts on a non-Helius endpoint", async () => {
    const seen: string[] = [];
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        seen.push(c.method);
        if (c.method === "getMultipleAccounts") return mintAccount(c);
        return { jsonrpc: "2.0", id: c.id, result: [row(CURVE, 800n), row(WALLET, 150n)] };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url });
    expect((await client.getTopHoldersBatch(["mintA"], 25)).get("mintA")).toEqual({
      status: "found",
      supply: "1000",
      holders: [{ owner: WALLET, pct: 15, accounts: [`acct-${WALLET}`] }],
    });
    expect(seen).toEqual(["getMultipleAccounts", "getProgramAccounts"]);
  });

  it("asks for a classic SPL Token mint's accounts with the 165-byte size filter, and a Token-2022 mint's without", async () => {
    const filters: unknown[] = [];
    let program = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        if (c.method === "getMultipleAccounts") {
          const res = mintAccount(c);
          res.result.value[0]!.owner = program;
          return res;
        }
        filters.push((c.params[1] as { filters: unknown[] }).filters);
        return { jsonrpc: "2.0", id: c.id, result: [row(WALLET, 150n)] };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url });
    // The second read is a new mint-account answer: inside five minutes the first program is reused.
    expect((await client.getTopHoldersBatch(["mintA"], 25, { nowMs: 0 })).get("mintA")?.status).toBe("found");
    program = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    await client.getTopHoldersBatch(["mintA"], 25, { nowMs: 5 * 60_000 });
    expect(filters).toEqual([
      [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: "mintA" } }],
      [{ memcmp: { offset: 0, bytes: "mintA" } }],
    ]);
  });

  it("leaves Stonks' fee wallet out of any coin's top holders, whatever its fee authority", async () => {
    const serve = (authority: string | null) =>
      startServer((calls) =>
        calls.map((c) => {
          if (c.method === "getMultipleAccounts")
            return {
              jsonrpc: "2.0",
              id: c.id,
              result: {
                value: [
                  {
                    owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
                    data: {
                      parsed: {
                        info: {
                          supply: "1000",
                          ...(authority
                            ? {
                                extensions: [
                                  {
                                    extension: "transferFeeConfig",
                                    state: { withdrawWithheldAuthority: authority },
                                  },
                                ],
                              }
                            : {}),
                        },
                      },
                    },
                  },
                ],
              },
            };
          return { jsonrpc: "2.0", id: c.id, result: [row(STONKS_FEE_WALLET, 300n), row(WALLET, 150n)] };
        }),
      );
    const stonks = await serve(STONKS_FEE_WALLET);
    expect(
      (await new HeliusClient({ rpcUrl: stonks.url }).getTopHoldersBatch(["mintA"], 25)).get("mintA"),
    ).toEqual({
      status: "found",
      supply: "1000",
      holders: [{ owner: WALLET, pct: 15, accounts: [`acct-${WALLET}`] }],
    });
    const other = await serve(null);
    expect(
      (await new HeliusClient({ rpcUrl: other.url }).getTopHoldersBatch(["mintA"], 25)).get("mintA"),
    ).toMatchObject({ status: "found", holders: [{ owner: WALLET, pct: 15 }] });
  });

  it("fails a mint that isn't a token mint, or whose accounts didn't come back", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) =>
        c.method === "getMultipleAccounts"
          ? { jsonrpc: "2.0", id: c.id, result: { value: [{ owner: "someProgram", data: {} }] } }
          : { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "busy" } },
      ),
    );
    const client = new HeliusClient({ rpcUrl: url });
    expect((await client.getTopHoldersBatch(["mintA"], 25)).get("mintA")).toEqual({
      status: "failed",
      reason: "not a token mint",
    });
  });

  it("reuses a mint's program and supply for five minutes and still enumerates token accounts", async () => {
    let supply = "1000";
    const seen: { method: string; params: unknown[] }[] = [];
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        seen.push({ method: c.method, params: c.params });
        if (c.method === "getMultipleAccounts") {
          const res = mintAccount(c);
          res.result.value[0]!.data.parsed.info.supply = supply;
          return res;
        }
        return {
          jsonrpc: "2.0",
          id: c.id,
          result: { accounts: [row(CURVE, 800n), row(WALLET, 150n)], paginationKey: null },
        };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url, isHelius: true });
    const read = (nowMs: number) => client.getTopHoldersBatch(["mintA"], 25, { nowMs });
    expect((await read(0)).get("mintA")).toMatchObject({
      status: "found",
      supply: "1000",
      holders: [{ owner: WALLET, pct: 15 }],
    });
    supply = "500";
    expect((await read(5 * 60_000 - 1)).get("mintA")).toMatchObject({
      status: "found",
      supply: "1000",
      holders: [{ owner: WALLET, pct: 15 }],
    });
    expect(seen.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(1);
    const pages = seen.filter((c) => c.method === "getProgramAccountsV2");
    expect(pages).toHaveLength(2);
    expect(pages.every((c) => c.params[0] === TOKEN_2022)).toBe(true);
    expect((await read(5 * 60_000)).get("mintA")).toMatchObject({
      status: "found",
      supply: "500",
      holders: [{ owner: WALLET, pct: 30 }],
    });
    expect(seen.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(2);
    expect(seen.filter((c) => c.method === "getProgramAccountsV2")).toHaveLength(3);
  });

  it("drops expired mint accounts and keeps at most 5,000", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) =>
        c.method === "getMultipleAccounts"
          ? mintAccount(c)
          : { jsonrpc: "2.0", id: c.id, result: { accounts: [row(WALLET, 150n)], paginationKey: null } },
      ),
    );
    const client = new HeliusClient({ rpcUrl: url, isHelius: true });
    const kept = (
      client as unknown as { mintAccounts: Map<string, { program: string; supply: bigint; atMs: number }> }
    ).mintAccounts;
    await client.getTopHoldersBatch(["mintA"], 25, { nowMs: 0 });
    expect([...kept.keys()]).toEqual(["mintA"]);
    // Another mint read after mintA's five minutes ran out drops mintA.
    await client.getTopHoldersBatch(["mintB"], 25, { nowMs: 6 * 60_000 });
    expect([...kept.keys()]).toEqual(["mintB"]);
    for (let i = 0; i < 5_000; i += 1)
      kept.set(`filler${i}`, { program: TOKEN_2022, supply: 1n, atMs: 6 * 60_000 });
    await client.getTopHoldersBatch(["mintA"], 25, { nowMs: 6 * 60_000 });
    expect(kept.size).toBe(5_000);
    expect(kept.has("mintB")).toBe(false);
    expect(kept.has("mintA")).toBe(true);
  });

  it("retries a mint whose account read failed instead of caching the failure", async () => {
    let failMint = true;
    const seen: string[] = [];
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        seen.push(c.method);
        if (c.method === "getMultipleAccounts") {
          if (failMint) return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "busy" } };
          return mintAccount(c);
        }
        return {
          jsonrpc: "2.0",
          id: c.id,
          result: { accounts: [row(WALLET, 150n)], paginationKey: null },
        };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url, isHelius: true });
    expect((await client.getTopHoldersBatch(["mintA"], 25, { nowMs: 0 })).get("mintA")).toEqual({
      status: "failed",
      reason: "mint read failed",
    });
    failMint = false;
    expect((await client.getTopHoldersBatch(["mintA"], 25, { nowMs: 1_000 })).get("mintA")).toMatchObject({
      status: "found",
      supply: "1000",
      holders: [{ owner: WALLET, pct: 15 }],
    });
    expect(seen.filter((m) => m === "getMultipleAccounts")).toHaveLength(2);
    expect(seen.filter((m) => m === "getProgramAccountsV2")).toHaveLength(1);
  });

  it("asks getMultipleAccounts only for mints missing from the five-minute cache", async () => {
    const gmaKeys: unknown[] = [];
    const enumerated: string[] = [];
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        if (c.method === "getMultipleAccounts") {
          gmaKeys.push(c.params[0]);
          return mintAccount(c);
        }
        const filters = (c.params[1] as { filters: { memcmp?: { bytes: string } }[] }).filters;
        const mint = filters.find((f) => f.memcmp)?.memcmp?.bytes;
        if (mint) enumerated.push(mint);
        return {
          jsonrpc: "2.0",
          id: c.id,
          result: { accounts: [row(WALLET, 150n)], paginationKey: null },
        };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url, isHelius: true });
    await client.getTopHoldersBatch(["mintA"], 25, { nowMs: 0 });
    enumerated.length = 0;
    await client.getTopHoldersBatch(["mintA", "mintB"], 25, { nowMs: 60_000 });
    expect(gmaKeys).toEqual([["mintA"], ["mintB"]]);
    expect(enumerated.sort()).toEqual(["mintA", "mintB"]);
  });
});

describe("HeliusClient.getFundersBatch", () => {
  const SOL = 1_000_000_000;
  /** A token account opened for the wallet by someone else: no SOL moves to it. */
  const ataOpened = {
    blockTime: SECONDS,
    meta: { err: null, preBalances: [5 * SOL, 0, 0], postBalances: [5 * SOL - 2_000_000, 0, 2_000_000] },
    transaction: {
      message: { accountKeys: ["opener", "w", "ata"], header: { numRequiredSignatures: 1 } },
    },
  };
  const funded = {
    blockTime: SECONDS + 60,
    meta: { err: null, preBalances: [3 * SOL, 0], postBalances: [2 * SOL - 5000, 1 * SOL] },
    transaction: { message: { accountKeys: ["F", "w"], header: { numRequiredSignatures: 1 } } },
  };

  it("walks past a first transaction that paid no SOL in, to the funding", async () => {
    const txs: Record<string, unknown> = { s1: ataOpened, s2: funded };
    const { url, requests } = await startServer((calls) =>
      calls.map((c) =>
        c.method === "getSignaturesForAddress"
          ? {
              jsonrpc: "2.0",
              id: c.id,
              // Newest first; s0 failed and is skipped.
              result: [
                { signature: "s3", blockTime: SECONDS + 120 },
                { signature: "s2", blockTime: SECONDS + 60 },
                { signature: "s1", blockTime: SECONDS },
                { signature: "s0", blockTime: SECONDS - 1, err: { InstructionError: [0, "x"] } },
              ],
            }
          : { jsonrpc: "2.0", id: c.id, result: txs[c.params[0] as string] ?? null },
      ),
    );
    const client = new HeliusClient({ rpcUrl: url });
    const result = await client.getFundersBatch(["w"]);
    expect(result.get("w")).toMatchObject({ status: "found", funder: "F", amountSol: 1, reads: 2 });
    const asked = requests.flatMap((r) => r.body as { method: string; params: unknown[] }[]);
    expect(asked.filter((c) => c.method === "getTransaction").map((c) => c.params[0])).toEqual(["s1", "s2"]);
  });

  it("reuses a page it is handed instead of reading it again", async () => {
    const txs: Record<string, unknown> = { s1: ataOpened, s2: funded };
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: txs[c.params[0] as string] ?? null })),
    );
    const client = new HeliusClient({ rpcUrl: url });
    const page = [
      { signature: "s2", blockTime: SECONDS + 60 },
      { signature: "s1", blockTime: SECONDS },
    ];
    const result = await client.getFundersBatch(["w"], { pagesOf: new Map([["w", page]]) });
    expect(result.get("w")).toMatchObject({ status: "found", funder: "F", amountSol: 1 });
    const asked = requests.flatMap((r) => r.body as { method: string }[]);
    expect(asked.some((c) => c.method === "getSignaturesForAddress")).toBe(false);
  });

  it("keeps a known funder on a re-read, paying only the page, unless the wallet revived", async () => {
    const now = (SECONDS + 200 * 86_400) * 1000;
    const nowS = now / 1000;
    // b: a busy wallet, active all along (a full page with no gap) - the stored funder stands.
    const steady = Array.from({ length: 1000 }, (_, i) => ({ signature: `n${i}`, blockTime: nowS - 60 * i }));
    // v: idle 200 days, paid again an hour ago - the stored funder is stale, so it is read.
    const refund = {
      blockTime: nowS - 3600,
      meta: { err: null, preBalances: [9 * SOL, 0], postBalances: [7 * SOL - 5000, 2 * SOL] },
      transaction: { message: { accountKeys: ["R", "v"], header: { numRequiredSignatures: 1 } } },
    };
    const revived = [
      { signature: "b2", blockTime: nowS - 60 },
      { signature: "r1", blockTime: nowS - 3600 },
      { signature: "s1", blockTime: SECONDS },
    ];
    const { url, requests } = await startServer((calls) =>
      calls.map((c) =>
        c.method === "getSignaturesForAddress"
          ? { jsonrpc: "2.0", id: c.id, result: c.params[0] === "b" ? steady : revived }
          : { jsonrpc: "2.0", id: c.id, result: c.params[0] === "r1" ? refund : null },
      ),
    );
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });
    const knownOf = new Map([
      ["b", { funder: "KB", amountSol: 2, fundedAt: new Date(SECONDS * 1000) }],
      ["v", { funder: "KV", amountSol: 1, fundedAt: new Date(SECONDS * 1000) }],
    ]);
    const result = await client.getFundersBatch(["b", "v"], { nowMs: now, knownOf });
    expect(result.get("b")).toMatchObject({
      status: "found",
      funder: "KB",
      amountSol: 2,
      reads: 0,
      lastActivityAt: new Date((nowS - 0) * 1000),
    });
    expect(result.get("b")).not.toHaveProperty("sorted");
    expect(result.get("v")).toMatchObject({ status: "found", funder: "R", revived: true });
    const asked = requests.flatMap((r) => r.body as { method: string; params: unknown[] }[]);
    expect(asked.filter((c) => c.method === "getTransactionsForAddress")).toHaveLength(0);
    expect(asked.filter((c) => c.method === "getSignaturesForAddress")).toHaveLength(2);
  });

  it("reads a wallet woken after a week idle for who paid it then, even on a full page", async () => {
    // An aged farm wallet: one transaction 200 days ago, then paid again an hour before the read.
    const now = (SECONDS + 200 * 86_400) * 1000;
    const nowS = now / 1000;
    const refund = {
      blockTime: nowS - 3600,
      meta: { err: null, preBalances: [9 * SOL, 0], postBalances: [7 * SOL - 5000, 2 * SOL] },
      transaction: { message: { accountKeys: ["R", "w"], header: { numRequiredSignatures: 1 } } },
    };
    const refundX = {
      ...refund,
      transaction: { message: { accountKeys: ["RX", "x"], header: { numRequiredSignatures: 1 } } },
    };
    const txs: Record<string, unknown> = { s1: ataOpened, r1: refund, rx: refundX };
    const quiet = [
      { signature: "b2", blockTime: nowS - 60 },
      { signature: "r1", blockTime: nowS - 3600 },
      { signature: "s1", blockTime: SECONDS },
    ];
    // A full page: a busy stretch after the wake, the gap, and older history past it.
    const busy = [
      ...Array.from({ length: 900 }, (_, i) => ({ signature: `n${i}`, blockTime: nowS - 60 - i })),
      { signature: "rx", blockTime: nowS - 3600 },
      ...Array.from({ length: 99 }, (_, i) => ({ signature: `o${i}`, blockTime: SECONDS - i })),
    ];
    const { url, requests } = await startServer((calls) =>
      calls.map((c) =>
        c.method === "getSignaturesForAddress"
          ? { jsonrpc: "2.0", id: c.id, result: c.params[0] === "w" ? quiet : busy }
          : { jsonrpc: "2.0", id: c.id, result: txs[c.params[0] as string] ?? null },
      ),
    );
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });
    const result = await client.getFundersBatch(["w"], { nowMs: now });
    expect(result.get("w")).toMatchObject({
      status: "found",
      funder: "R",
      fundedAt: new Date((nowS - 3600) * 1000),
      revived: true,
      lastActivityAt: new Date((nowS - 60) * 1000),
    });

    const full = await client.getFundersBatch(["x"], { nowMs: now });
    // The page is full, but it holds the gap: the stretch's first transaction names the payer,
    // without the 10-credit sorted lookup.
    expect(full.get("x")).toMatchObject({ status: "found", funder: "RX", revived: true, reads: 1 });
    const asked = requests.flatMap((r) => r.body as { method: string; params: unknown[] }[]);
    expect(asked.map((c) => c.method)).not.toContain("getTransactionsForAddress");
    expect(asked.filter((c) => c.method === "getTransaction").map((c) => c.params[0])).toEqual(["r1", "rx"]);
  });

  it("reads a busy wallet's oldest transactions in one sorted lookup", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, blockTime: SECONDS + i }));
    const { url, requests } = await startServer((calls) =>
      calls.map((c) =>
        c.method === "getSignaturesForAddress"
          ? { jsonrpc: "2.0", id: c.id, result: page }
          : { jsonrpc: "2.0", id: c.id, result: { data: [ataOpened, funded] } },
      ),
    );
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });
    const result = await client.getFundersBatch(["w"]);
    expect(result.get("w")).toMatchObject({ status: "found", funder: "F", sorted: true });
    const sorted = requests
      .flatMap((r) => r.body as { method: string; params: [string, Record<string, unknown>] }[])
      .find((c) => c.method === "getTransactionsForAddress");
    expect(sorted!.params[1]).toMatchObject({ sortOrder: "asc", limit: 4 });
  });
});

describe("activityStretch", () => {
  const DAY = 86_400;
  const now = 1_800_000_000;

  it("starts the stretch after the newest week-long idle gap", () => {
    // An aged farm wallet: a few transactions months ago, empty since, paid again an hour ago.
    const times = [now, now - 1800, now - 3600, now - 200 * DAY, now - 201 * DAY];
    expect(activityStretch(times)).toEqual({
      activeSince: new Date((now - 3600) * 1000),
      lastActivityAt: new Date(now * 1000),
    });
  });

  it("finds no start when no gap reaches a week", () => {
    const gap = WALLET_DORMANT_GAP_MS / 1000 - 60;
    expect(activityStretch([now, now - gap, now - 2 * gap])).toEqual({
      lastActivityAt: new Date(now * 1000),
    });
    expect(activityStretch([])).toEqual({});
  });
});

describe("HeliusClient.getEarliestActivityBatch on an aged wallet", () => {
  it("reports when its current stretch began, and settles a full page that holds the gap", async () => {
    const DAY = 86_400;
    const sig = (t: number, i: number) => ({ signature: `s${t}-${i}`, blockTime: t });
    const revived = [SECONDS, SECONDS - 3600, SECONDS - 300 * DAY].map(sig);
    const busyRevived = [
      ...Array.from({ length: 150 }, (_, i) => sig(SECONDS - i * 10, i)),
      ...Array.from({ length: 50 }, (_, i) => sig(SECONDS - 90 * DAY - i, i)),
    ];
    const { url, requests } = await startServer((body) =>
      (body as { id: string; method: string; params: [string] }[]).map((c) => ({
        jsonrpc: "2.0",
        id: c.id,
        result: c.params[0] === "revived" ? revived : busyRevived,
      })),
    );
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });

    const result = await client.getEarliestActivityBatch(["revived", "busy"], {
      boundSufficientBefore: new Date((SECONDS - DAY) * 1000),
    });

    expect(result.get("revived")).toEqual({
      status: "found",
      earliestActivityAt: new Date((SECONDS - 300 * DAY) * 1000),
      activeSince: new Date((SECONDS - 3600) * 1000),
      lastActivityAt: new Date(SECONDS * 1000),
    });
    expect(result.get("busy")).toMatchObject({
      status: "older-than",
      activeSince: new Date((SECONDS - 149 * 10) * 1000),
    });
    const methods = requests.flatMap((r) => (r.body as { method: string }[]).map((c) => c.method));
    expect(methods).not.toContain("getTransactionsForAddress");
  });
});

describe("HeliusClient.getCpmmLpLockedBatch", () => {
  const MINT = bs58.encode(new Uint8Array(32).fill(3));
  const LP_MINT = bs58.encode(new Uint8Array(32).fill(4));

  function poolSlice(): string {
    const data = new Uint8Array(CPMM_LP_READ_BYTES);
    data.set(bs58.decode(LP_MINT), 136);
    data.set(bs58.decode(MINT), 200);
    new DataView(data.buffer).setBigUint64(333, 1000n, true);
    return Buffer.from(data).toString("base64");
  }

  it("reads the share of a pool's LP burned or in Raydium's lock", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => {
        if (c.method === "getTokenLargestAccounts")
          return {
            jsonrpc: "2.0",
            id: c.id,
            result: {
              value: [
                { address: "locked", amount: "700" },
                { address: "wallet", amount: "200" },
              ],
            },
          };
        if (c.method === "getTokenSupply")
          return { jsonrpc: "2.0", id: c.id, result: { value: { amount: "900" } } };
        const keys = c.params[0] as string[];
        const parsed = (c.params[1] as { encoding: string }).encoding === "jsonParsed";
        return {
          jsonrpc: "2.0",
          id: c.id,
          result: {
            value: keys.map((k) =>
              parsed
                ? {
                    data: {
                      parsed: { info: { owner: k === "locked" ? RAYDIUM_CPMM_LOCK_AUTHORITY : WALLET } },
                    },
                  }
                : k === "NotCpmm"
                  ? { owner: OTHER, data: [poolSlice(), "base64"] }
                  : k === "Missing"
                    ? null
                    : { owner: RAYDIUM_CPMM_PROGRAM, data: [poolSlice(), "base64"] },
            ),
          },
        };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url });
    const result = await client.getCpmmLpLockedBatch(
      new Map([
        ["Pool", MINT],
        ["NotCpmm", MINT],
        ["Missing", MINT],
        ["OtherCoin", OTHER],
      ]),
    );
    // 100 burned (issued 1000, supply 900) and 700 locked of 1000.
    expect(result.get("Pool")).toBeCloseTo(0.8);
    expect(result.get("NotCpmm")).toBeNull();
    expect(result.get("Missing")).toBeNull();
    expect(result.get("OtherCoin")).toBeNull();
  });

  it("fails a pool whose reads came back without an answer", async () => {
    const { url } = await startServer((calls) =>
      calls.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "busy" } })),
    );
    const client = new HeliusClient({ rpcUrl: url });
    expect((await client.getCpmmLpLockedBatch(new Map([["Pool", MINT]]))).get("Pool")).toBe("failed");
  });
});

describe("HeliusClient retry on timeout, by method", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** fetch that times out its first request and answers every later one with `reply`. */
  function timesOutOnce(reply: (calls: { id: string }[]) => unknown) {
    let sent = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent += 1;
      if (sent === 1) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const calls = JSON.parse(String(init.body)) as { id: string }[];
      return new Response(JSON.stringify(reply(calls)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return () => sent;
  }

  it("retries a batch of cheap account reads once (the screen's Mayhem and authority reads)", async () => {
    const sent = timesOutOnce((calls) =>
      calls.map((c) => ({
        jsonrpc: "2.0",
        id: c.id,
        result: { context: { slot: 1 }, value: [{ data: { parsed: { info: { mintAuthority: null } } } }] },
      })),
    );
    const out = await new HeliusClient({ rpcUrl: "https://rpc.example/a" }).getMintAuthorityStatusBatch([
      "m",
    ]);
    expect(sent()).toBe(2);
    expect(out.get("m")?.status).toBe("found");
  });

  it("doesn't retry a timed-out batch of full transactions, which was most likely billed", async () => {
    const sent = timesOutOnce((calls) => calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: null })));
    await new HeliusClient({ rpcUrl: "https://rpc.example/b" }).getTransactionsBatch(["sig"]);
    expect(sent()).toBe(1);
  });
});

describe("HeliusClient.findLaunchLabPool", () => {
  const FUMP = "BnSxLBu3ehevdDBzWdLeAApKT1i2pE3JhPaoNZdAvbij";

  it("finds a pool on a likely quote by its address, with no program scan", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) => {
        const keys = (c.params[0] as string[]) ?? [];
        return {
          jsonrpc: "2.0",
          id: c.id,
          result: {
            context: { slot: 1 },
            value: keys.map((k) => (k === launchLabPoolOf(FUMP) ? { owner: LAUNCHLAB_PROGRAM } : null)),
          },
        };
      }),
    );
    const client = new HeliusClient({ rpcUrl: url });
    expect(await client.findLaunchLabPool(FUMP)).toBe("7mwjUjRrnotTkhD33cxW3bPjLjPkpTC14J1MA2K4Ncqm");
    const methods = requests.flatMap((r) => (r.body as { method: string }[]).map((c) => c.method));
    expect(methods).toEqual(["getMultipleAccounts"]);
  });

  it("scans the program when no likely quote has the pool", async () => {
    const { url, requests } = await startServer((calls) =>
      calls.map((c) =>
        c.method === "getMultipleAccounts"
          ? {
              jsonrpc: "2.0",
              id: c.id,
              result: { context: { slot: 1 }, value: (c.params[0] as string[]).map(() => null) },
            }
          : { jsonrpc: "2.0", id: c.id, result: [{ pubkey: "ScannedPool" }] },
      ),
    );
    const client = new HeliusClient({ rpcUrl: url });
    expect(await client.findLaunchLabPool(FUMP)).toBe("ScannedPool");
    const methods = requests.flatMap((r) => (r.body as { method: string }[]).map((c) => c.method));
    expect(methods).toEqual(["getMultipleAccounts", "getProgramAccounts"]);
  });
});
