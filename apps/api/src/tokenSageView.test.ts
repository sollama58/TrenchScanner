import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TokenSageAnalysis } from "@trenchscanner/core";
import { sageCreatorFee, sageLogo, sageRead, sageTrack, xUrl } from "./tokenSageView.js";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/core/src/datasources/fixtures/tokensage/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as { analysis: TokenSageAnalysis };

describe("TokenSage view", () => {
  it("shapes a full read for the dashboard", () => {
    const read = sageRead(fixture("full").analysis, "full")!;
    expect(read.referent).toMatchObject({
      label: "Peanut (squirrel)",
      kind: "famous_animal",
      confidence: 0.97,
    });
    expect(read.referent!.supportedBy).toEqual(["name", "description"]);
    expect(read.categories[0]).toMatchObject({ label: "animal", confidence: 0.97 });
    // Strongest evidence first, and only the pieces that carry weight.
    expect(read.evidence.length).toBeGreaterThan(0);
    expect(read.evidence.every((e) => e.weight > 0)).toBe(true);
    expect(read.evidence[0]!.weight).toBeGreaterThanOrEqual(read.evidence[read.evidence.length - 1]!.weight);
    expect(read.x).toMatchObject({
      read: true,
      relation: "launch_announcement",
      verdict: "unrelated",
      url: "https://x.com/i/status/1791351500217754008",
    });
    expect(read.x!.author).toMatchObject({ handle: "elonmusk", followers: 241704623 });
    expect(read.flags.map((f) => f.code)).toContain("x_content_mismatch");
    // Nothing that names the creator wallet rides along.
    expect(JSON.stringify(read)).not.toContain("CTfBTtxhtAyGEysdjp9owVQvjSwPjtrzEGB9ZgAKewsY");
  });

  it("names the main category and marks a copy apart from it", () => {
    const full = fixture("full").analysis;
    // Older rules: no main_category, so the most confident category stands in.
    const old = sageRead(full, "full")!;
    expect(old.mainCategory).toMatchObject({ label: "animal", confidence: 0.97 });
    const copy = sageRead(
      {
        ...full,
        categories: [
          { label: "derivative", confidence: 0.75 },
          { label: "animal", confidence: 0.54 },
        ],
        main_category: { label: "animal", confidence: 0.54 },
        lineage: { kind: "late_copy", of_name: "Zubbo" },
      },
      "full",
    )!;
    expect(copy.mainCategory).toEqual({ label: "animal", confidence: 0.54 });
    expect(copy.copyMark).toBe("late_copy");
    expect(sageRead({ ...full, lineage: { kind: "original" } }, "full")!.copyMark).toBeNull();
    expect(
      sageRead(
        { ...full, lineage: null, copy_of: [], categories: [{ label: "derivative/meme", confidence: 0.6 }] },
        "full",
      )!.copyMark,
    ).toBe("copy");
  });

  it("shows a recycled X account as info, as rules 0.23.0 do, on a read stored before", () => {
    const read = sageRead(
      {
        flags: [
          { code: "recycled_x_account", severity: "high" },
          { code: "spoofed_tweet_handle", severity: "high" },
        ],
      },
      "full",
    )!;
    expect(read.flags.map((f) => [f.code, f.severity])).toEqual([
      ["recycled_x_account", "info"],
      ["spoofed_tweet_handle", "high"],
    ]);
  });

  it("copes with missing parts and clips long text", () => {
    expect(sageRead(null, "basic")).toBeNull();
    const read = sageRead({ summary: "x".repeat(5000), categories: [{ label: 5 } as never] }, "basic")!;
    expect(read.summary!.length).toBeLessThanOrEqual(900);
    expect(read.categories).toEqual([]);
    expect(read.referent).toBeNull();
    expect(read.x).toBeNull();
  });

  it("shows where the creator fee goes (rules 0.19.0), and nothing when the read doesn't say", () => {
    // KindnessCoin, from the brief: 99% to a donate.gg charity, 1% to the creator.
    const fee = sageCreatorFee({
      destination: "charity",
      mechanism: "sharing_config",
      mutable: false,
      shares: { creator: 0.01, charity: 0.99 },
      recipients: [
        {
          address: "8PQxd6VmfGPMyg8WPnfkT9jUTmtE7UsnDmvBKXeAVP9z",
          share: 0.01,
          kind: "creator",
          is_creator: true,
        },
        {
          address: "CYoJ1Hs3Ldk7aa1wpZQ4KfqVQy9AzB9mT3x4Q8qWgyxC",
          share: 0.99,
          kind: "charity",
          is_creator: false,
          lifetime_received: 57.286407196,
        },
      ],
      summary: "creator fees go to charity: 99% to a charity via donate.gg, 1% to the creator wallet",
    })!;
    expect(fee.destination).toBe("charity");
    expect(fee.shares).toEqual([
      { kind: "charity", share: 0.99 },
      { kind: "creator", share: 0.01 },
    ]);
    // The creator's own wallet stays out; another recipient links to Solscan.
    expect(fee.recipients[0]).toMatchObject({ kind: "creator", label: null, url: null });
    expect(fee.recipients[1]).toMatchObject({
      kind: "charity",
      label: "CYoJ…gyxC",
      url: "https://solscan.io/account/CYoJ1Hs3Ldk7aa1wpZQ4KfqVQy9AzB9mT3x4Q8qWgyxC",
      lifetimeReceived: 57.286407196,
    });
    // A GitHub recipient links to its account; anything else in `url` is dropped.
    const github = sageCreatorFee({
      destination: "github",
      recipients: [
        { kind: "github", share: 1, github_login: "shelldon", url: "https://github.com/shelldon" },
        { kind: "github", share: 0, url: "javascript:alert(1)" },
      ],
    })!;
    expect(github.recipients[0]).toMatchObject({ label: "shelldon", url: "https://github.com/shelldon" });
    expect(github.recipients[1]).toMatchObject({ label: null, url: null });
    // Rules 0.22.0+: no login, so the recipient is named and linked by its numeric user_id.
    const byId = sageCreatorFee({
      destination: "github",
      recipients: [
        {
          kind: "github",
          share: 1,
          user_id: "9919",
          github_login: null,
          url: "https://api.github.com/user/9919",
        },
        { kind: "github", share: 0, user_id: 4242 },
        { kind: "github", share: 0, user_id: "../evil" },
      ],
    })!;
    expect(byId.recipients[0]).toMatchObject({
      label: "GitHub #9919",
      url: "https://api.github.com/user/9919",
    });
    expect(byId.recipients[1]).toMatchObject({
      label: "GitHub #4242",
      url: "https://api.github.com/user/4242",
    });
    expect(byId.recipients[2]).toMatchObject({ label: null, url: null });
    // An unreadable split (rules 0.21.0) keeps its destination and summary.
    expect(
      sageCreatorFee({ destination: "unknown", summary: "fee split; recipients unreadable" }),
    ).toMatchObject({
      destination: "unknown",
      summary: "fee split; recipients unreadable",
    });
    expect(sageCreatorFee(null)).toBeNull();
    expect(sageCreatorFee(undefined)).toBeNull();
    expect(sageCreatorFee({ summary: "no destination" })).toBeNull();
    expect(sageRead(fixture("full").analysis, "full")!.creatorFee).toBeNull();
  });

  it("only links to X over https", () => {
    expect(xUrl({ raw: { twitter: "https://x.com/someone" } })).toBe("https://x.com/someone");
    expect(xUrl({ raw: { twitter: "javascript:alert(1)" } })).toBeNull();
    expect(xUrl({ raw: { twitter: "https://evil.example/x.com" } })).toBeNull();
    expect(xUrl({ x: { ref: { tweet_id: "12<3" } } })).toBeNull();
  });

  it("lines the narrative's week up against every narrative's", () => {
    const d1 = new Date("2026-10-06T00:00:00Z");
    const d2 = new Date("2026-10-07T00:00:00Z");
    const rows = [
      { day: d1, label: "animal", count: 40, alerts: 10, graded: 10, won2x: 3 },
      { day: d1, label: "celebrity", count: 20, alerts: 5, graded: 5, won2x: 0 },
      { day: d2, label: "celebrity", count: 30, alerts: 8, graded: 6, won2x: 2 },
    ];
    const track = sageTrack(rows, [{ label: "animal/dog", confidence: 0.9 }])!;
    expect(track.label).toBe("animal");
    expect(track.days).toEqual([
      { day: "2026-10-06", count: 40, alerts: 10, graded: 10, won2x: 3 },
      { day: "2026-10-07", count: 0, alerts: 0, graded: 0, won2x: 0 },
    ]);
    expect(track.all).toEqual([
      { day: "2026-10-06", alerts: 15, graded: 15, won2x: 3 },
      { day: "2026-10-07", alerts: 8, graded: 6, won2x: 2 },
    ]);
    expect(sageTrack(rows, [{ label: "political", confidence: 0.9 }])).toBeNull();
    expect(sageTrack(rows, null)).toBeNull();
    // A copy of a dog coin tracks under animal (its main category), not derivative.
    expect(sageTrack(rows, [{ label: "derivative", confidence: 0.75 }], "animal")!.label).toBe("animal");
  });
});

describe("pair and logo marks (rules 0.25.0, 0.27.0)", () => {
  it("carries the pair token, its pump.fun mark and what it is about", () => {
    const doc = fixture("paired_token").analysis;
    doc.market!.pair!.pumpfun = true;
    expect(sageRead(doc, "full")!.pair).toEqual({
      kind: "token",
      symbol: "BONK",
      name: "Bonk",
      pumpfun: true,
      buildsOn: true,
      about: "Bonk",
    });
    // Older reads have no pumpfun field: not known.
    expect(sageRead(fixture("paired_token").analysis, "full")!.pair!.pumpfun).toBeNull();
  });

  it("shows the logo's best class only from a 0.5 score", () => {
    const m = "siglip-b16-q8/1";
    expect(
      sageLogo([
        { label: "cartoon_char", score: 0.04, model: m },
        { label: "dog", score: 0.91, model: m },
      ]),
    ).toEqual({ label: "dog", score: 0.91 });
    expect(sageLogo([{ label: "dog", score: 0.49, model: m }])).toBeNull();
    expect(sageLogo([{ label: "none", score: 0.9, model: m }])).toBeNull();
    expect(sageLogo([])).toBeNull();
    expect(sageLogo(undefined)).toBeNull();
    expect(sageLogo([null, { label: 3 }, "dog"])).toBeNull();
    // Basic reads and older rules carry no labels.
    expect(sageRead(fixture("paired_token").analysis, "basic")!.logo).toBeNull();
    expect(sageRead({ image: { labels: [{ label: "frog", score: 0.8, model: m }] } }, "full")!.logo).toEqual({
      label: "frog",
      score: 0.8,
    });
  });
});
