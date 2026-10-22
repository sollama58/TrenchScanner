import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { applyCharityNames, charityNamesByMint, type CardCreatorFee } from "./curatedFeed.js";

let server: Server | undefined;
const previousBase = process.env.PUMPFUN_BASE_URL;

afterEach(async () => {
  if (previousBase === undefined) delete process.env.PUMPFUN_BASE_URL;
  else process.env.PUMPFUN_BASE_URL = previousBase;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("applyCharityNames", () => {
  it("attaches a loaded name only to a charity coin", () => {
    const fees = new Map<string, CardCreatorFee>([
      ["charityMint", { destination: "charity", summary: "creator fees go to charity", bps: null }],
      ["devMint", { destination: "creator", summary: null, bps: null }],
    ]);
    applyCharityNames(
      fees,
      new Map([
        ["charityMint", "National Breast Cancer Foundation"],
        ["devMint", "National Breast Cancer Foundation"],
      ]),
    );
    expect(fees.get("charityMint")?.charityName).toBe("National Breast Cancer Foundation");
    expect(fees.get("devMint")?.charityName).toBeUndefined();
  });
});

describe("charityNamesByMint", () => {
  it("loads the name from Pump.fun and does not ask again while it is remembered", async () => {
    let hits = 0;
    server = createServer((req, res) => {
      hits += 1;
      const mint = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          mint,
          is_charity: true,
          charity_name: "St. Jude Children's Research Hospital",
        }),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
    process.env.PUMPFUN_BASE_URL = `http://127.0.0.1:${address.port}`;
    const mint = "CharityMint1111111111111111111111111111111";
    expect((await charityNamesByMint([mint])).get(mint)).toBe("St. Jude Children's Research Hospital");
    expect((await charityNamesByMint([mint])).get(mint)).toBe("St. Jude Children's Research Hospital");
    expect(hits).toBe(1);
  });

  it("sets charityName from a live pump payload that omits is_charity", async () => {
    const name = "St. Jude Children's Research Hospital";
    server = createServer((req, res) => {
      const mint = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ mint, name: "KindnessCoin", charityName: name }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
    process.env.PUMPFUN_BASE_URL = `http://127.0.0.1:${address.port}`;
    const mint = "LiveCharityMint111111111111111111111111111";
    const loaded = await charityNamesByMint([mint]);
    expect(loaded.get(mint)).toBe(name);
    const fees = new Map<string, CardCreatorFee>([
      [mint, { destination: "charity", summary: "creator fees go to charity", bps: null }],
    ]);
    applyCharityNames(fees, loaded);
    expect(fees.get(mint)?.charityName).toBe(name);
  });
});
