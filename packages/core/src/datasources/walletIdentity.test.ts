import { afterEach, describe, expect, it, vi } from "vitest";
import { HeliusIdentityClient } from "./walletIdentity.js";

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
});
