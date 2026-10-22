import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  charityNameFromPumpCoin,
  ipfsMetadataCid,
  LIST_BLOCK_BACKOFF_MS,
  parseLaunchMetadata,
  PumpFunClient,
} from "./pumpfun.js";

let server: Server | undefined;

/** A local stand-in for Pump.fun's frontend API: `pages[offset / limit]`, or a 500 for "fail". */
async function serve(pages: (unknown[] | "fail")[]): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  server = createServer((req, res) => {
    paths.push(req.url ?? "");
    const q = new URL(req.url ?? "", "http://x").searchParams;
    const page = pages[Number(q.get("offset")) / Number(q.get("limit"))] ?? [];
    res.setHeader("content-type", "application/json");
    if (page === "fail") {
      res.statusCode = 500;
      res.end("{}");
      return;
    }
    res.end(JSON.stringify(page));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
  return { url: `http://127.0.0.1:${address.port}`, paths };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("PumpFunClient.currentlyLive", () => {
  it("maps each live coin to its viewer count, reading one page when it isn't full", async () => {
    const { url, paths } = await serve([
      [
        { mint: "a", is_currently_live: true, num_participants: 67 },
        { mint: "b", is_currently_live: true },
        { mint: "c", is_currently_live: false, num_participants: 3 },
      ],
    ]);
    const live = await new PumpFunClient({ baseUrl: url }).currentlyLive({ limit: 5 });
    expect([...live!].map(([mint, l]) => [mint, l.viewers, l.coin?.mintAddress])).toEqual([
      ["a", 67, "a"],
      ["b", null, "b"],
    ]);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("/coins/currently-live?");
  });

  it("reads the next page while pages come back full", async () => {
    const { url, paths } = await serve([
      [
        { mint: "a", num_participants: 1 },
        { mint: "b", num_participants: 2 },
      ],
      [{ mint: "c", num_participants: 3 }],
    ]);
    const live = await new PumpFunClient({ baseUrl: url }).currentlyLive({ limit: 2 });
    expect([...live!.keys()]).toEqual(["a", "b", "c"]);
    expect(paths).toHaveLength(2);
  });

  it("answers null (unknown) when the last allowed page is still full", async () => {
    // Coins past the page cap would otherwise read as a definite "not live".
    const { url, paths } = await serve([
      [{ mint: "a" }, { mint: "b" }],
      [{ mint: "c" }, { mint: "d" }],
    ]);
    expect(await new PumpFunClient({ baseUrl: url }).currentlyLive({ limit: 2, maxPages: 2 })).toBeNull();
    expect(paths).toHaveLength(2);
  });

  it("answers null (unknown), not an empty set, when the feed fails", async () => {
    const { url } = await serve(["fail"]);
    expect(await new PumpFunClient({ baseUrl: url }).currentlyLive()).toBeNull();
  });
});

describe("PumpFunClient discovery paging", () => {
  it("asks for pages under Pump.fun's 70-a-page cap, at back-to-back offsets", async () => {
    const { url, paths } = await serve([]);
    await new PumpFunClient({ baseUrl: url }).discoverNewMints();
    const asked = paths.map((p) => new URL(p, "http://x").searchParams);
    expect(asked.every((q) => Number(q.get("limit")) <= 70)).toBe(true);
    const offsets = asked.map((q) => Number(q.get("offset"))).sort((a, b) => a - b);
    const limit = Number(asked[0]!.get("limit"));
    expect(offsets).toEqual(offsets.map((_, i) => i * limit));
  });
});

describe("PumpFunClient discovered coins", () => {
  it("keeps a real creation time and drops one that isn't a date", async () => {
    const coin = (mint: string, created_timestamp: unknown) => ({
      mint,
      symbol: "X",
      name: "X",
      created_timestamp,
    });
    const { url } = await serve([
      [
        coin("Good111111111111111111111111111111111111111", 1_760_000_000_000),
        coin("Huge111111111111111111111111111111111111111", 1e20),
        coin("Text111111111111111111111111111111111111111", "1760000000000"),
        coin("Late111111111111111111111111111111111111111", Date.now() + 86_400_000),
      ],
    ]);
    const found = await new PumpFunClient({ baseUrl: url }).discoverNewMints();
    const created = new Map(found.map((c) => [c.mintAddress.slice(0, 4), c.createdAt]));
    expect(created.get("Good")).toEqual(new Date(1_760_000_000_000));
    expect(created.get("Huge")).toBeUndefined();
    expect(created.get("Text")).toBeUndefined();
    expect(created.get("Late")).toBeUndefined();
  });
});

describe("PumpFunClient Mayhem flag", () => {
  it("marks a coin Pump.fun reports in any Mayhem state, and no other", async () => {
    const coin = (mint: string, mayhem_state: unknown) => ({ mint, symbol: "X", name: "X", mayhem_state });
    const { url } = await serve([
      [
        coin("Actv111111111111111111111111111111111111111", "active"),
        coin("Done111111111111111111111111111111111111111", "completed"),
        coin("Null111111111111111111111111111111111111111", null),
        coin("None111111111111111111111111111111111111111", undefined),
      ],
    ]);
    const found = await new PumpFunClient({ baseUrl: url }).discoverNewMints();
    const flag = new Map(found.map((c) => [c.mintAddress.slice(0, 4), c.mayhemMode]));
    expect(flag.get("Actv")).toBe(true);
    expect(flag.get("Done")).toBe(true);
    expect(flag.get("Null")).toBeUndefined();
    expect(flag.get("None")).toBeUndefined();
  });
});

describe("charityNameFromPumpCoin", () => {
  const hospital = "St. Jude Children's Research Hospital";

  it("reads charity_name on a coin Pump.fun marks is_charity", () => {
    expect(charityNameFromPumpCoin({ is_charity: true, charity_name: `  ${hospital}  ` })).toBe(hospital);
  });

  it("reads charity.name when the name is nested, and ignores the coin's own name", () => {
    expect(
      charityNameFromPumpCoin({
        is_charity: true,
        name: "KindnessCoin",
        charity: { name: "American Red Cross" },
      }),
    ).toBe("American Red Cross");
  });

  it("is blank unless the coin is a charity coin with a real name", () => {
    expect(charityNameFromPumpCoin({ is_charity: false, charity_name: hospital })).toBeNull();
    expect(charityNameFromPumpCoin({ is_charity: false, charityName: hospital })).toBeNull();
    expect(charityNameFromPumpCoin({ is_charity: true })).toBeNull();
    expect(charityNameFromPumpCoin({ is_charity: true, charity_name: "   " })).toBeNull();
    expect(
      charityNameFromPumpCoin({
        is_charity: true,
        charity_name: "H16fEMZN9b8Zmhh5Ara343WdZdSdgn2P8oUkAGdB57Ru",
      }),
    ).toBeNull();
    expect(charityNameFromPumpCoin({ name: "KindnessCoin" })).toBeNull();
    expect(charityNameFromPumpCoin(null)).toBeNull();
  });

  it("reads a live coin payload that names the charity and omits is_charity", () => {
    // frontend-api-v3 was blocked (2026-10-22). These are the spellings Pump.fun has used.
    expect(charityNameFromPumpCoin({ charityName: hospital })).toBe(hospital);
    expect(charityNameFromPumpCoin({ charity_name: `  ${hospital}  ` })).toBe(hospital);
    expect(charityNameFromPumpCoin({ name: "KindnessCoin", charity: { name: "American Red Cross" } })).toBe(
      "American Red Cross",
    );
    expect(charityNameFromPumpCoin({ charity: { charityName: hospital } })).toBe(hospital);
    expect(charityNameFromPumpCoin({ charity: { charity_name: hospital } })).toBe(hospital);
    expect(charityNameFromPumpCoin({ charity: { charity: { name: hospital } } })).toBe(hospital);
    expect(charityNameFromPumpCoin({ is_charity: true, charityName: hospital })).toBe(hospital);
    // The organization field wins over a different name nested beside it.
    expect(charityNameFromPumpCoin({ charityName: hospital, charity: { name: "American Red Cross" } })).toBe(
      hospital,
    );
  });
});

describe("PumpFunClient.charityName", () => {
  async function serveCoin(status: number, body: unknown): Promise<string> {
    server = createServer((_req, res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
    return `http://127.0.0.1:${address.port}`;
  }

  it("loads the charity name from coins-v2", async () => {
    const url = await serveCoin(200, {
      mint: "m",
      is_charity: true,
      charity_name: "National Breast Cancer Foundation",
    });
    expect(await new PumpFunClient({ baseUrl: url }).charityName("m")).toBe(
      "National Breast Cancer Foundation",
    );
  });

  it("loads charityName when the live coin omits is_charity", async () => {
    const url = await serveCoin(200, {
      mint: "m",
      name: "KindnessCoin",
      charityName: "St. Jude Children's Research Hospital",
    });
    expect(await new PumpFunClient({ baseUrl: url }).charityName("m")).toBe(
      "St. Jude Children's Research Hospital",
    );
  });

  it("is null when Pump.fun has no such coin, and throws when the host fails", async () => {
    const url = await serveCoin(404, { message: "Not Found" });
    expect(await new PumpFunClient({ baseUrl: url }).charityName("m")).toBeNull();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const failing = await serveCoin(500, {});
    await expect(new PumpFunClient({ baseUrl: failing }).charityName("m")).rejects.toThrow();
  });
});

describe("PumpFunClient.launchTime", () => {
  async function serveCoin(status: number, body: unknown): Promise<string> {
    server = createServer((_req, res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
    return `http://127.0.0.1:${address.port}`;
  }

  it("reads the coin's created_timestamp", async () => {
    const url = await serveCoin(200, { mint: "m", created_timestamp: 1_791_674_763_000 });
    expect(await new PumpFunClient({ baseUrl: url }).launchTime("m")).toEqual(new Date(1_791_674_763_000));
  });

  it("answers null for a coin Pump.fun doesn't have, and throws when it can't answer", async () => {
    const url = await serveCoin(404, { message: "Not Found" });
    expect(await new PumpFunClient({ baseUrl: url }).launchTime("m")).toBeNull();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const failing = await serveCoin(500, {});
    await expect(new PumpFunClient({ baseUrl: failing }).launchTime("m")).rejects.toThrow();
  });
});

describe("PumpFunClient.liveMarketCap", () => {
  /** A stand-in that answers the single-coin endpoint with `coin` (null body for "none"). */
  async function serveCoin(coin: unknown, status = 200): Promise<{ url: string; paths: string[] }> {
    const paths: string[] = [];
    server = createServer((req, res) => {
      paths.push(req.url ?? "");
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(coin));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
    return { url: `http://127.0.0.1:${address.port}`, paths };
  }

  it("reads the coin's usd_market_cap from the single-coin endpoint", async () => {
    const { url, paths } = await serveCoin({ mint: "m", usd_market_cap: 13_164.2 });
    expect(await new PumpFunClient({ baseUrl: url }).liveMarketCap("m")).toBe(13_164.2);
    expect(paths).toEqual(["/coins-v2/m"]);
  });

  it("is null for an unknown coin or one with no usable figure, and throws on a server error", async () => {
    let { url } = await serveCoin({ error: "not found" }, 404);
    expect(await new PumpFunClient({ baseUrl: url }).liveMarketCap("m")).toBeNull();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    ({ url } = await serveCoin({ mint: "m", usd_market_cap: 0 }));
    expect(await new PumpFunClient({ baseUrl: url }).liveMarketCap("m")).toBeNull();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    ({ url } = await serveCoin({}, 500));
    await expect(new PumpFunClient({ baseUrl: url }).liveMarketCap("m")).rejects.toThrow();
  });
});

describe("PumpFunClient.takeListStats", () => {
  it("counts failed coin-list pages and names a 403 as a block", async () => {
    server = createServer((_req, res) => {
      res.statusCode = 403;
      res.setHeader("content-type", "text/html");
      res.end("<!DOCTYPE html><title>Just a moment...</title>");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const client = new PumpFunClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    expect(await client.discoverNewMints({ pages: 2 })).toEqual([]);
    const stats = client.takeListStats();
    expect(stats).toMatchObject({ pages: 2, failed: 2 });
    expect(stats.lastError).toMatch(/403.*Cloudflare/);
    expect(client.takeListStats()).toEqual({ pages: 0, failed: 0, skipped: 0 });

    // Blocked: the list is left alone for a while instead of failing every page every cycle.
    await client.discoverNewMints({ pages: 3 });
    expect(client.takeListStats()).toEqual({ pages: 0, failed: 0, skipped: 3 });

    // Past the wait, one page asks whether the block has lifted; the rest stay skipped.
    const later = Date.now() + LIST_BLOCK_BACKOFF_MS + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      await client.discoverNewMints({ pages: 3 });
      expect(client.takeListStats()).toMatchObject({ pages: 1, failed: 1, skipped: 2 });
    } finally {
      clock.mockRestore();
    }
  });

  it("counts answered pages as not failed", async () => {
    const { url } = await serve([[{ mint: "a" }]]);
    const client = new PumpFunClient({ baseUrl: url });
    await client.discoverNewMints({ pages: 1 });
    expect(client.takeListStats()).toEqual({ pages: 1, failed: 0, skipped: 0 });
  });
});

describe("PumpFunClient.coinDetails", () => {
  it("reads one coin's description and socials", async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/coins-v2/Mint1") {
        res.end(
          JSON.stringify({ mint: "Mint1", symbol: "ONE", description: "hi", twitter: "https://x.com/one" }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const client = new PumpFunClient({
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    expect(await client.coinDetails("Mint1")).toMatchObject({
      mintAddress: "Mint1",
      symbol: "ONE",
      description: "hi",
      hasTwitter: true,
      twitterUrl: "https://x.com/one",
    });
    expect(await client.coinDetails("Missing")).toBeNull();
  });
});

describe("launch metadata", () => {
  const cid = "bafkreibuifrxzohrvlpgdztmwku4o7wggni72irolspurpn3toi5mfjq2q";

  it("reads the CID of an IPFS-hosted URI only", () => {
    expect(ipfsMetadataCid(`https://ipfs.io/ipfs/${cid}`)).toBe(cid);
    expect(ipfsMetadataCid(`https://${cid}.ipfs.w3s.link`)).toBe(cid);
    expect(ipfsMetadataCid("https://meta.uxento.io/data/33304f82")).toBeUndefined();
    expect(ipfsMetadataCid(`http://ipfs.io/ipfs/${cid}`)).toBeUndefined();
  });

  it("maps the metadata JSON to a coin, an absent description as a known none", () => {
    expect(
      parseLaunchMetadata("M", {
        name: "BITRIOT",
        symbol: "BITRIOT",
        image: "https://ipfs.io/ipfs/x",
        twitter: "https://x.com/bitriottech",
        website: "https://bitriot.tech",
      }),
    ).toMatchObject({
      mintAddress: "M",
      description: "",
      hasTwitter: true,
      hasWebsite: true,
      hasTelegram: false,
      imageUrl: "https://ipfs.io/ipfs/x",
    });
    expect(parseLaunchMetadata("M", [])).toBeNull();
    expect(parseLaunchMetadata("M", "nope")).toBeNull();
  });
});
