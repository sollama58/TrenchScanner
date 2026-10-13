import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanWalletName, HeliusIdentityClient, isPumpfunName } from "./walletIdentity.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("HeliusIdentityClient", () => {
  it("reads a named wallet, and a 404 as none", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          address: "a",
          type: "exchange",
          name: "Binance 1",
          category: "Centralized Exchange",
          tags: ["Centralized Exchange"],
        }),
      )
      .mockResolvedValueOnce(
        json({ error: "No identity information available for this address", code: 404 }, 404),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new HeliusIdentityClient("key");
    expect(await client.identity("a")).toEqual({
      status: "found",
      value: {
        type: "exchange",
        name: "Binance 1",
        category: "Centralized Exchange",
        tags: ["Centralized Exchange"],
      },
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.helius.xyz/v1/wallet/a/identity");
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ "X-Api-Key": "key" });
    expect(await client.identity("b")).toEqual({ status: "none" });
  });

  it("says a plan that can't read it is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "requires a paid plan" }, 403)));
    expect(await new HeliusIdentityClient("key").identity("a")).toEqual({ status: "unavailable" });
  });

  it("reads a batch, naming what Helius knows and null for the rest", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json([
        { address: "a", type: "exchange", name: "OKX", category: "Centralized Exchange", tags: [] },
        { address: "b", type: "unknown", name: null, category: null, tags: [] },
        { address: "zzz", type: "wallet", name: "Not asked", tags: [] },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await new HeliusIdentityClient("key").batchIdentity(["a", "b", "c"]);
    expect(res.status).toBe("found");
    const value = res.status === "found" ? res.value : null;
    expect([...value!.entries()]).toEqual([
      ["a", { type: "exchange", name: "OKX", category: "Centralized Exchange", tags: [] }],
      ["b", null],
      ["c", null],
    ]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.helius.xyz/v1/wallet/batch-identity");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ addresses: ["a", "b", "c"] });
  });

  it("says a plan that can't read a batch is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "requires a paid plan" }, 403)));
    expect(await new HeliusIdentityClient("key").batchIdentity(["a"])).toEqual({ status: "unavailable" });
  });
});

describe("cleanWalletName", () => {
  it('shows a "NAME" on Pumpfun label as just NAME', () => {
    expect(cleanWalletName('"degenking" on Pumpfun')).toBe("degenking");
    expect(cleanWalletName("\u201cMoon Boy\u201d on Pump.fun")).toBe("Moon Boy");
    expect(cleanWalletName('"x" on pump fun')).toBe("x");
  });

  it("marks a Pump.fun username, in a batch read too", async () => {
    expect(isPumpfunName('"degenking" on Pumpfun')).toBe(true);
    expect(isPumpfunName("Binance 1")).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(json([{ address: "a", type: "wallet", name: '"degen" on Pumpfun', tags: [] }])),
    );
    const res = await new HeliusIdentityClient("key").batchIdentity(["a"]);
    expect(res.status === "found" ? res.value.get("a") : null).toEqual({
      type: "wallet",
      name: "degen",
      category: null,
      tags: [],
      pumpfun: true,
    });
  });

  it("leaves every other name alone", () => {
    expect(cleanWalletName("Binance 1")).toBe("Binance 1");
    expect(cleanWalletName('"quoted" on Raydium')).toBe('"quoted" on Raydium');
  });
});
