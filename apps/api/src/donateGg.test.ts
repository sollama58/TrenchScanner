import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { applyCharityNames, type CardCreatorFee } from "./curatedFeed.js";
import {
  charitiesFromDonateConfig,
  clearDonateConfigCache,
  donateConfigCharities,
  expandCharityRecipients,
} from "./donateGg.js";
import { cardFeeRecipients, feeRecipientsFromAnalysis } from "./feeRecipients.js";

const CREATOR = "8PQxd6VmfGPMyg8WPnfkT9jUTmtE7UsnDmvBKXeAVP9z";
const PDA = "CYoJ4CC1oGt1Hk1y2XZQ9aDJHsh7kZSFSHMWvChAgyxC";
const CONFIG = "H16fEMZN9b8Zmhh5Ara343WdZdSdgn2P8oUkAGdB57Ru";
const PAIR = "JCZBhPewgvoAYHCmirP3vvXe3VpXiXVY1gSsj1o2ZsCw";

let server: Server | undefined;
const previousBase = process.env.DONATE_GG_BASE_URL;

afterEach(async () => {
  clearDonateConfigCache();
  if (previousBase === undefined) delete process.env.DONATE_GG_BASE_URL;
  else process.env.DONATE_GG_BASE_URL = previousBase;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("charitiesFromDonateConfig", () => {
  it("reads each enabled charity's name and its share of the config", () => {
    expect(
      charitiesFromDonateConfig({
        id: { base58: PAIR },
        charities: [
          { name: "Pandas International", weight: "75", isEnabled: true },
          { name: "St. Jude Children's Research Hospital", weight: "25", isEnabled: true },
          { name: "Gone", weight: "50", isEnabled: false },
          { name: PDA, weight: "50" },
        ],
      }),
    ).toEqual([
      { name: "Pandas International", bps: 7500 },
      { name: "St. Jude Children's Research Hospital", bps: 2500 },
    ]);
  });

  it("splits evenly without weights and is empty for anything that is not a config", () => {
    expect(charitiesFromDonateConfig({ charities: [{ name: "A" }, { name: "B" }] })).toEqual([
      { name: "A", bps: 5000 },
      { name: "B", bps: 5000 },
    ]);
    expect(charitiesFromDonateConfig({ error: "nope" })).toEqual([]);
    expect(charitiesFromDonateConfig(null)).toEqual([]);
  });
});

describe("expandCharityRecipients", () => {
  it("names a donation PDA from its config and splits its share among the config's charities", () => {
    const chain = feeRecipientsFromAnalysis([
      { address: CREATOR, share_bps: 100, kind: "creator" },
      { address: PDA, share_bps: 9900, kind: "charity", charity_config_id: PAIR },
    ]);
    const expanded = expandCharityRecipients(
      chain,
      new Map([
        [
          PAIR,
          [
            { name: "Pandas International", bps: 6000 },
            { name: "St. Jude", bps: 4000 },
          ],
        ],
      ]),
    );
    expect(cardFeeRecipients(expanded)).toEqual([
      { label: "8PQx…VP9z", bps: 100 },
      { label: "Pandas International", bps: 5940, charity: true },
      { label: "St. Jude", bps: 3960, charity: true },
    ]);
  });

  it("leaves a PDA whose config was not loaded as its short address", () => {
    const chain = feeRecipientsFromAnalysis([
      { address: PDA, share_bps: 10000, kind: "charity", charity_config_id: CONFIG },
    ]);
    expect(cardFeeRecipients(expandCharityRecipients(chain, new Map()))).toEqual([
      { label: "CYoJ…gyxC", bps: 10000, charity: true },
    ]);
  });

  it("gives a single named charity to the card as its charity name", () => {
    const chain = expandCharityRecipients(
      feeRecipientsFromAnalysis([
        { address: PDA, share_bps: 10000, kind: "charity", charity_config_id: CONFIG },
      ]),
      new Map([[CONFIG, [{ name: "St. Jude Children's Research Hospital", bps: 10000 }]]]),
    );
    const fees = new Map<string, CardCreatorFee>([
      ["mint", { destination: "charity", summary: "creator fees go to charity", bps: null }],
    ]);
    applyCharityNames(fees, new Map(), new Map(), new Map([["mint", chain]]));
    expect(fees.get("mint")?.charityName).toBe("St. Jude Children's Research Hospital");
    expect(fees.get("mint")?.recipients).toEqual([
      { label: "St. Jude Children's Research Hospital", bps: 10000, charity: true },
    ]);
  });
});

describe("donateConfigCharities", () => {
  it("loads a config once and remembers it", async () => {
    let hits = 0;
    server = createServer((req, res) => {
      hits += 1;
      const id = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
      if (id !== CONFIG) {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: { base58: CONFIG },
          charities: [{ name: "St. Jude Children's Research Hospital", weight: "100", isEnabled: true }],
        }),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    process.env.DONATE_GG_BASE_URL = `http://127.0.0.1:${port}/api/v1`;
    const first = await donateConfigCharities([CONFIG, PAIR, "not a key"]);
    expect(first.get(CONFIG)).toEqual([{ name: "St. Jude Children's Research Hospital", bps: 10000 }]);
    expect(first.has(PAIR)).toBe(false);
    const second = await donateConfigCharities([CONFIG, PAIR]);
    expect(second.get(CONFIG)?.[0]?.name).toBe("St. Jude Children's Research Hospital");
    expect(hits).toBe(2);
  });

  it("does not throw when donate.gg is down", async () => {
    process.env.DONATE_GG_BASE_URL = "http://127.0.0.1:1/api/v1";
    expect((await donateConfigCharities([CONFIG], 500)).size).toBe(0);
  });
});
