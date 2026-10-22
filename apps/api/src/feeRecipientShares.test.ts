import { describe, expect, it } from "vitest";
import { feeRecipientsFromAnalysis, mergeCharityShares } from "./feeRecipients.js";

const CHARITY = "CYoJ1Hs3Ldk7aa1wpZQ4KfqVQy9AzB9mT3x4Q8qWgyxC";
const CREATOR = "8PQxd6VmfGPMyg8WPnfkT9jUTmtE7UsnDmvBKXeAVP9z";
const OTHER = "4NVt2u8V7YwQj3k6mP8sR2tU5vW7xY9zA1bC3dE5fG7";

describe("feeRecipientsFromAnalysis", () => {
  it("names a charity and shortens a recipient that has no name", () => {
    expect(
      feeRecipientsFromAnalysis([
        { address: CREATOR, share: 0.01, kind: "creator", is_creator: true },
        { address: CHARITY, share: 0.99, kind: "charity", charity_name: "Red Cross" },
        { address: OTHER, share_bps: 0, kind: "wallet" },
        { kind: "charity", share: 0.5 },
      ]),
    ).toEqual([
      { label: "8PQx…VP9z", bps: 100, kind: "creator", named: false, address: CREATOR },
      { label: "Red Cross", bps: 9900, kind: "charity", named: true, address: CHARITY },
    ]);
  });
});

describe("mergeCharityShares", () => {
  const chain = feeRecipientsFromAnalysis([
    { address: CREATOR, share_bps: 100, kind: "creator" },
    { address: CHARITY, share_bps: 6000, kind: "charity" },
    { address: OTHER, share_bps: 3900, kind: "charity" },
  ]);

  it("puts one Pump.fun name on the single charity slot and leaves the other address short", () => {
    const one = feeRecipientsFromAnalysis([
      { address: CREATOR, share: 0.01, kind: "creator" },
      { address: CHARITY, share: 0.99, kind: "charity" },
    ]);
    expect(mergeCharityShares(one, [{ name: "Red Cross", bps: null, address: null }])).toEqual([
      { label: "8PQx…VP9z", bps: 100 },
      { label: "Red Cross", bps: 9900 },
    ]);
  });

  it("names each charity when the counts agree, and does not copy one name onto both", () => {
    expect(
      mergeCharityShares(chain, [
        { name: "Red Cross", bps: null, address: null },
        { name: "Unicef", bps: null, address: null },
      ]),
    ).toEqual([
      { label: "8PQx…VP9z", bps: 100 },
      { label: "Red Cross", bps: 6000 },
      { label: "Unicef", bps: 3900 },
    ]);
    expect(mergeCharityShares(chain, [{ name: "Red Cross", bps: null, address: null }])).toEqual([
      { label: "8PQx…VP9z", bps: 100 },
      { label: "CYoJ…gyxC", bps: 6000 },
      { label: "4NVt…5fG7", bps: 3900 },
    ]);
  });

  it("matches a Pump.fun name to the recipient with the same address", () => {
    expect(
      mergeCharityShares(chain, [
        { name: "Unicef", bps: 3900, address: OTHER },
        { name: "Red Cross", bps: 6000, address: CHARITY },
      ]),
    ).toEqual([
      { label: "8PQx…VP9z", bps: 100 },
      { label: "Red Cross", bps: 6000 },
      { label: "Unicef", bps: 3900 },
    ]);
  });

  it("uses the Pump.fun list when the chain named nobody", () => {
    expect(
      mergeCharityShares(
        [],
        [
          { name: "Red Cross", bps: 6000, address: null },
          { name: "Unicef", bps: 4000, address: null },
        ],
      ),
    ).toEqual([
      { label: "Red Cross", bps: 6000 },
      { label: "Unicef", bps: 4000 },
    ]);
  });
});
