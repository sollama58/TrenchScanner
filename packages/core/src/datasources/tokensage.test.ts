import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TokenSageClient,
  tokenSageHints,
  narrativeDepthCovers,
  narrativeFieldsFromAnalysis,
  normalizeSocialUrl,
  storableAnalysis,
  narrativeDetails,
  type TokenSageAnalysis,
  type TokenSageBatchItem,
} from "./tokensage.js";

describe("normalizeSocialUrl", () => {
  it("turns a bare X handle into its x.com URL", () => {
    expect(normalizeSocialUrl("@frogcoin", "twitter")).toBe("https://x.com/frogcoin");
    expect(normalizeSocialUrl("frog_coin", "twitter")).toBe("https://x.com/frog_coin");
  });

  it("keeps https X links and upgrades http", () => {
    expect(normalizeSocialUrl("https://x.com/a/status/123", "twitter")).toBe("https://x.com/a/status/123");
    expect(normalizeSocialUrl("http://twitter.com/a", "twitter")).toBe("https://twitter.com/a");
    expect(normalizeSocialUrl("x.com/i/communities/9", "twitter")).toBe("https://x.com/i/communities/9");
  });

  it("drops non-X hosts in the twitter field, bad schemes and junk", () => {
    expect(normalizeSocialUrl("https://example.com", "twitter")).toBeNull();
    expect(normalizeSocialUrl("javascript:alert(1)", "website")).toBeNull();
    expect(normalizeSocialUrl("https://user:pw@example.com", "website")).toBeNull();
    expect(normalizeSocialUrl("", "website")).toBeNull();
    expect(normalizeSocialUrl(undefined, "website")).toBeNull();
    expect(normalizeSocialUrl("not a url", "website")).toBeNull();
  });

  it("keeps a website", () => {
    expect(normalizeSocialUrl("frog.xyz", "website")).toBe("https://frog.xyz/");
  });
});

describe("narrativeFieldsFromAnalysis", () => {
  const doc: TokenSageAnalysis = {
    mint: "Mint1",
    depth: "full",
    analyzed_at: "2026-10-06T18:00:00Z",
    referent: { label: "Pepe", kind: "meme", confidence: 0.9 },
    categories: [
      { label: "animal/frog", confidence: 0.92 },
      { label: "meme_template/pepe_wojak_chad", confidence: 1.4 },
    ],
    flags: [
      { code: "copycat", severity: "warn" },
      { code: "copycat", severity: "warn" },
      { code: "x_link_reused", severity: "warn" },
    ],
    summary: "  A frog coin  ",
    versions: { rules: "r7" },
  };

  it("keeps what the rows store, clamped and de-duplicated", () => {
    const f = narrativeFieldsFromAnalysis(doc, "complete");
    expect(f.depth).toBe("full");
    expect(f.referentLabel).toBe("Pepe");
    expect(f.referentKind).toBe("meme");
    expect(f.categories[1]!.confidence).toBe(1);
    expect(f.flags).toEqual(["copycat", "x_link_reused"]);
    expect(f.summary).toBe("A frog coin");
    expect(f.rulesVersion).toBe("r7");
    expect(f.analyzedAt?.toISOString()).toBe("2026-10-06T18:00:00.000Z");
  });

  it("reads the X match, treating an unknown verdict as missing", () => {
    const withMatch = { ...doc, x: { match: { fit: 0.55, verdict: "related" as const } } };
    expect(narrativeFieldsFromAnalysis(withMatch, "complete")).toMatchObject({
      xFit: 0.55,
      xVerdict: "related",
    });
    const unknown = { ...doc, x: { match: { fit: 0, verdict: "unknown" as const } } };
    expect(narrativeFieldsFromAnalysis(unknown, "complete")).toMatchObject({ xFit: null, xVerdict: null });
  });

  it("tolerates a sparse document", () => {
    const f = narrativeFieldsFromAnalysis({ mint: "M", depth: "basic", analyzed_at: "bad" }, "partial");
    expect(f).toMatchObject({
      depth: "basic",
      categories: [],
      flags: [],
      referentLabel: null,
      analyzedAt: null,
    });
  });
});

describe("narrativeDepthCovers", () => {
  it("full covers basic, not the other way round", () => {
    expect(narrativeDepthCovers("full", "basic")).toBe(true);
    expect(narrativeDepthCovers("basic", "full")).toBe(false);
    expect(narrativeDepthCovers("basic", "basic")).toBe(true);
    expect(narrativeDepthCovers(null, "basic")).toBe(false);
  });
});

describe("tokenSageHints", () => {
  it("sends only what discovery stored", () => {
    expect(
      tokenSageHints({
        name: "Dog",
        symbol: "DOG",
        description: null,
        imageUrl: "https://ipfs.io/ipfs/x",
        twitterUrl: "https://x.com/dog",
        websiteUrl: null,
        firstSeenAt: new Date("2026-10-06T18:00:00Z"),
      }),
    ).toEqual({
      name: "Dog",
      symbol: "DOG",
      image_url: "https://ipfs.io/ipfs/x",
      twitter: "https://x.com/dog",
      created_at: "2026-10-06T18:00:00.000Z",
    });
    expect(tokenSageHints({ imageUrl: "http://insecure" })).toBeUndefined();
  });
});

describe("TokenSageClient base URL", () => {
  const base = (u: string) =>
    (new TokenSageClient({ baseUrl: u, apiKey: "k" }) as unknown as { baseUrl: string }).baseUrl;
  it("adds https to a bare host and upgrades http, keeping local test servers", () => {
    expect(base("tokensage-api.onrender.com/")).toBe("https://tokensage-api.onrender.com");
    expect(base("http://tokensage-api.onrender.com")).toBe("https://tokensage-api.onrender.com");
    expect(base(" https://ts.example.com// ")).toBe("https://ts.example.com");
    expect(base("http://127.0.0.1:10000")).toBe("http://127.0.0.1:10000");
  });
});

/**
 * Real responses from TokenSage (rules 0.10.0): GET /v1/tokens/{ca} at full and basic depth
 * against its fake chain, a hints-only mint not on-chain yet (a partial answer), a batch with a
 * complete, an invalid and a pending item, a batch whose job failed (the RPC was down), and two
 * answers from its own integration tests: a coin paired against $BONK, and one whose linked
 * post replies to another account's post.
 */
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/tokensage/${name}.json`, import.meta.url), "utf8")) as {
    status: string;
    analysis: TokenSageAnalysis;
  } & { items: TokenSageBatchItem[] };

describe("narrativeFieldsFromAnalysis on real TokenSage responses", () => {
  it("reads a full-depth answer, X match included", () => {
    const { status, analysis } = fixture("full");
    expect(status).toBe("complete");
    const f = narrativeFieldsFromAnalysis(analysis, "complete");
    expect(f).toMatchObject({
      depth: "full",
      status: "complete",
      referentLabel: "Peanut (squirrel)",
      referentKind: "famous_animal",
      referentConfidence: 0.97,
      referentSupport: ["name", "description"],
      xFit: 0,
      xVerdict: "unrelated",
      pairKind: "sol",
      pairSymbol: "SOL",
      // It builds on the established $PNUT: a reference, not a live copycat.
      copiesRecent: false,
      rulesVersion: "0.10.0-full",
      // The post was read: Elon's own tweet, linked as the launch announcement.
      xRelation: "launch_announcement",
      xAuthorFollowers: 241704623,
      xPredatesTokenS: null,
      xReuseCount: 0,
      trendMatched: false,
      highFlagCount: 0,
      warnFlagCount: 1,
    });
    expect(f.categories.slice(0, 2)).toEqual([
      { label: "animal", confidence: 0.97 },
      { label: "animal/squirrel", confidence: 0.97 },
    ]);
    expect(f.categories).toHaveLength(7);
    expect(f.flags).toEqual(["references_known_coin", "x_content_mismatch"]);
    expect(f.summary).toMatch(/^Peanut the Squirrel 2\.0 \(\$PNUT2\) refers to Peanut/);
    expect(f.summary!.length).toBeLessThanOrEqual(500);
    expect(f.analyzedAt).toBeInstanceOf(Date);
  });

  it("reads a basic answer, where the X post was not fetched", () => {
    const { analysis } = fixture("basic");
    expect(analysis.x?.status).toBe("not_fetched");
    const f = narrativeFieldsFromAnalysis(analysis, "complete");
    expect(f).toMatchObject({
      depth: "basic",
      xFit: null,
      xVerdict: null,
      flags: ["references_known_coin"],
      referentSupport: ["name"],
      // Nothing about the post is known until it is read, whatever the document carries.
      xRelation: null,
      xAuthorFollowers: null,
      xReuseCount: null,
      highFlagCount: 0,
      warnFlagCount: 0,
    });
    expect(f.categories[0]).toEqual({ label: "derivative", confidence: 0.97 });
  });

  it("reads a partial answer made from our hints, with no market data", () => {
    const { status, analysis } = fixture("partial");
    expect(status).toBe("partial");
    expect(analysis.market?.pair).toBeNull();
    expect(analysis.caveats).toContain("hints: metadata supplied by caller");
    const f = narrativeFieldsFromAnalysis(analysis, "partial");
    expect(f).toMatchObject({
      depth: "basic",
      status: "partial",
      referentLabel: "Pepe the Frog",
      referentConfidence: 0.468,
      flags: ["non_pumpfun", "references_known_coin"],
      xFit: null,
      pairKind: null,
      pairSymbol: null,
    });
    expect(f.categories.map((c) => c.label)).toContain("derivative/reference");
  });

  it("reads a coin paired against another token, which takes that token's referent", () => {
    const f = narrativeFieldsFromAnalysis(fixture("paired_token").analysis, "complete");
    expect(f).toMatchObject({
      referentLabel: "Bonk",
      referentSupport: ["name", "chain"],
      pairKind: "token",
      pairSymbol: "BONK",
      flags: ["references_known_coin", "non_sol_pair"],
      copiesRecent: false,
    });
  });

  it("reads a coin whose post replies to another account's post", () => {
    const f = narrativeFieldsFromAnalysis(fixture("reply_post").analysis, "complete");
    expect(f).toMatchObject({
      depth: "full",
      referentLabel: "Peanut (squirrel)",
      referentSupport: ["x"],
      xFit: 0.85,
      xVerdict: "about_this_coin",
      copiesRecent: false,
      xRelation: "launch_announcement",
      xAuthorFollowers: 40,
      xReuseCount: 0,
    });
  });

  it("tells a live copycat from a reference, and says nothing for analyses that didn't say", () => {
    const { analysis } = fixture("full");
    const copy = analysis.copy_of![0]!;
    const withCopies = (copy_of: unknown) =>
      narrativeFieldsFromAnalysis({ ...analysis, copy_of } as TokenSageAnalysis, "complete").copiesRecent;
    expect(withCopies([copy, { ...copy, ticker: "PNUT2", recent: true }])).toBe(true);
    expect(withCopies([{ ticker: "PNUT", signals: [] }])).toBeNull();
    expect(withCopies([])).toBe(false);
    expect(withCopies("nonsense")).toBe(false);
  });

  it("matches the batch item shapes we branch on", () => {
    const { items } = fixture("batch");
    expect(items.map((i) => [i.status, i.error ?? null, i.job_id ?? null])).toEqual([
      ["complete", null, null],
      ["invalid", "not a Solana address (length)", null],
      ["pending", null, 4],
    ]);
    expect(narrativeFieldsFromAnalysis(items[0]!.analysis!, "complete").xVerdict).toBe("unrelated");
    const failed = fixture("failed_batch").items[0]!;
    expect(failed).toMatchObject({ status: "failed", analysis: null, job_id: 7 });
    expect(failed.error).toMatch(/^tokensage\.resolve\.rpc\.RpcError: .*retried automatically after 600 s/);
  });

  it("survives nulls, wrong types and unknown fields anywhere in the document", () => {
    const { analysis } = fixture("full");
    const broken = {
      ...analysis,
      mint: undefined,
      categories: { label: "animal" },
      flags: "copycat",
      referent: [],
      summary: 42,
      versions: null,
      analyzed_at: null,
      depth: "deepest",
      x: { match: { fit: "0.9", verdict: "about_this_coin" } },
      brand_new_field: { nested: [1, 2, 3] },
    } as unknown as TokenSageAnalysis;
    const f = narrativeFieldsFromAnalysis(broken, "complete");
    expect(f).toMatchObject({
      depth: "basic",
      categories: [],
      flags: [],
      referentLabel: null,
      summary: null,
      rulesVersion: null,
      analyzedAt: null,
      xFit: null,
      xVerdict: "about_this_coin",
    });
    for (const junk of [null, undefined, "x", 7, [], { x: null }, { x: { match: [] } }]) {
      expect(() =>
        narrativeFieldsFromAnalysis(junk as unknown as TokenSageAnalysis, "partial"),
      ).not.toThrow();
    }
  });

  it("skips malformed categories and flags but keeps the good ones", () => {
    const f = narrativeFieldsFromAnalysis(
      {
        categories: [null, { label: "a" }, { label: 5, confidence: 0.5 }, { label: "dog", confidence: 0.6 }],
        flags: [null, { code: "" }, { code: "copycat" }, "x_link_reused"],
      } as unknown as TokenSageAnalysis,
      "complete",
    );
    expect(f.categories).toEqual([{ label: "dog", confidence: 0.6 }]);
    expect(f.flags).toEqual(["copycat"]);
  });

  it("keeps a new X verdict as text, and strips NUL characters Postgres would reject", () => {
    const f = narrativeFieldsFromAnalysis(
      { summary: "a\u0000b", x: { match: { fit: 0.4, verdict: "parody" } } } as TokenSageAnalysis,
      "complete",
    );
    expect(f).toMatchObject({ summary: "ab", xFit: 0.4, xVerdict: "parody" });
  });
});

describe("storableAnalysis", () => {
  it("round-trips a real document unchanged", () => {
    const { analysis } = fixture("full");
    expect(storableAnalysis(analysis)).toEqual(analysis);
  });

  it("removes NUL characters and non-JSON values", () => {
    expect(
      storableAnalysis({ a: "x\u0000y", b: [Infinity, 1], c: undefined, "k\u0000": true, d: () => 1 }),
    ).toEqual({ a: "xy", b: [null, 1], k: true, d: null });
    expect(storableAnalysis("text")).toBeNull();
    expect(storableAnalysis([1])).toBeNull();
  });
});

describe("narrativeDetails", () => {
  it("shows the pair only when the coin trades against a token or a stock", () => {
    expect(narrativeDetails(fixture("paired_token").analysis).pair).toEqual({
      kind: "token",
      symbol: "BONK",
      name: "Bonk",
      underlying: null,
      buildsOn: true,
    });
    expect(narrativeDetails(fixture("full").analysis).pair).toBeNull();
    expect(narrativeDetails(fixture("partial").analysis).pair).toBeNull();
    const stock = {
      market: {
        pair: { kind: "tokenized_stock", symbol: "TSLAx", name: "Tesla xStock", underlying: "TSLA" },
      },
    };
    expect(narrativeDetails(stock).pair).toMatchObject({ kind: "tokenized_stock", underlying: "TSLA" });
  });

  it("reads the replied-to post and everyone in the conversation", () => {
    const d = narrativeDetails(fixture("reply_post").analysis);
    expect(d.postContext).toEqual([
      {
        relation: "replied_to",
        status: "ok",
        handle: "elonmusk",
        name: "Elon Musk",
        text: "Peanut the squirrel did nothing wrong",
        url: "https://x.com/elonmusk/status/1791351500217754008",
      },
    ]);
    expect(d.accounts.map((a) => [a.role, a.handle, a.followers])).toEqual([
      ["author", "nutdev", 40],
      ["replied_to_author", "elonmusk", 190000000],
    ]);
    expect(d.referentSupport).toEqual(["x"]);
  });

  it("lists copies with whether each is recent", () => {
    expect(narrativeDetails(fixture("full").analysis).copies).toEqual([
      {
        ticker: "PNUT",
        name: "Peanut the Squirrel",
        recent: false,
        rank: null,
        rankOf: null,
        rankWindowHours: null,
      },
    ]);
  });

  it("reads a recent copy's rank among same-name launches, and drops a rank that doesn't fit", () => {
    const d = narrativeDetails({
      copy_of: [
        { ticker: "PNUT2", recent: true, rank: 3, rank_of: 41, rank_window_hours: 24 },
        { ticker: "X", recent: true, rank: 5, rank_of: 2, rank_window_hours: 24 },
        { ticker: "Y", recent: true, rank: "1", rank_of: 2 },
      ],
    });
    expect(d.copies.map((c) => [c.rank, c.rankOf, c.rankWindowHours])).toEqual([
      [3, 41, 24],
      [null, null, null],
      [null, null, null],
    ]);
  });

  it("never throws, drops non-https links and NUL characters", () => {
    for (const junk of [null, 1, "x", [], { x: [] }, { market: { pair: "token" } }, { copy_of: [null, 3] }]) {
      expect(() => narrativeDetails(junk)).not.toThrow();
    }
    const d = narrativeDetails({
      x: {
        quoted: { url: "javascript:alert(1)", text: "hi\u0000there", author: { handle: 5 } },
        accounts: [null, { handle: "a", followers: "lots" }],
      },
    });
    expect(d.postContext).toEqual([
      { relation: "quoted", status: null, handle: null, name: null, text: "hithere", url: null },
    ]);
    expect(d.accounts).toEqual([
      { role: null, handle: "a", name: null, followers: null, verifiedType: null },
    ]);
  });
});

describe("narrativeFieldsFromAnalysis on a rules-0.15.0 document", () => {
  // Shaped after TokenSage's report of 2026-10-07 (lineage, referent wave, categories[].inputs,
  // x.account / credibility / reuse_rank, trend.score); no real document was to hand.
  const doc: TokenSageAnalysis = {
    mint: "CopyMint",
    depth: "full",
    analyzed_at: "2026-10-07T20:00:00Z",
    referent: {
      label: "Pepe the Frog",
      kind: "meme",
      confidence: 0.35,
      supported_by: ["copy_of"],
      wave: {
        launches_1h: 3,
        launches_6h: 13,
        launches_24h: 15,
        first_seen_at: "2026-10-06T19:00:00Z",
        rank_24h: 13,
      },
    },
    categories: [
      { label: "animal", confidence: 0.49, inputs: ["copy_of"] },
      { label: "animal/frog", confidence: 0.49, inputs: ["copy_of"] },
      { label: "derivative", confidence: 0.9, inputs: ["name", "db"] },
    ],
    copy_of: [
      {
        ticker: "ZUBBO",
        name: "Zubbo",
        mint: "OriginalMint",
        signals: ["name_exact"],
        created_at: "2026-10-06T14:00:00Z",
        recent: true,
        rank: 15,
        rank_of: 15,
        rank_window_hours: 24,
        original_age_s: 108000,
        original_market: { complete: false, curve_progress: 0.62, graduated_pool: null },
        match: ["name", "ticker"],
        image_distance: 3,
      },
    ],
    lineage: {
      kind: "late_copy",
      of_mint: "OriginalMint",
      of_name: "Zubbo",
      rank: 15,
      rank_of: 15,
      window_hours: 24,
      siblings_1h: 2,
      siblings_6h: 9,
      siblings_24h: 15,
      logo_reuse_24h: 4,
    },
    x: {
      status: "ok",
      relation: "official_account",
      author: { handle: "zubbo", followers: 3 },
      account: {
        created_at: "2026-10-07T19:53:00Z",
        age_at_launch_s: 420,
        made_for_coin: true,
        posts_total: 2,
      },
      credibility: 0.032,
      reuse_count: 0,
      reuse_rank: 1,
      match: { fit: 0.55, verdict: "related", basis: ["profile_name"] },
    },
    trend: { matched: true, score: 0.4, terms: [{ term: "zubbo", source: "google_trends", score: 0.4 }] },
    flags: [
      { code: "copycat", severity: "warn" },
      { code: "late_copy", severity: "warn" },
      { code: "x_account_made_for_coin", severity: "info" },
    ],
    versions: { rules: "0.15.0-full" },
  };

  it("stores the lineage, the wave, the X account and the trend score", () => {
    expect(narrativeFieldsFromAnalysis(doc, "complete")).toMatchObject({
      lineageKind: "late_copy",
      lineageRank: 15,
      lineageRankOf: 15,
      lineageOfMint: "OriginalMint",
      originalAgeS: 108000,
      originalCurveProgress: 0.62,
      originalComplete: false,
      siblings1h: 2,
      siblings6h: 9,
      siblings24h: 15,
      logoReuse24h: 4,
      waveLaunches1h: 3,
      waveLaunches6h: 13,
      waveLaunches24h: 15,
      waveRank24h: 13,
      // The surest category is "derivative", which two inputs agree on.
      topCategoryInputs: 2,
      xCredibility: 0.032,
      xAccountAgeS: 420,
      xAccountMadeForCoin: true,
      xReuseRank: 1,
      xVerdict: "related",
      xFit: 0.55,
      trendMatched: true,
      trendScore: 0.4,
      rulesVersion: "0.15.0-full",
    });
  });

  it("leaves every new field null on a document from older rules, or without a readable post", () => {
    const f = narrativeFieldsFromAnalysis(fixture("full").analysis, "complete");
    for (const k of [
      "lineageKind",
      "lineageRank",
      "originalAgeS",
      "siblings24h",
      "waveLaunches1h",
      "topCategoryInputs",
      "xCredibility",
      "xAccountAgeS",
      "xReuseRank",
      "trendScore",
    ] as const) {
      expect(f[k]).toBeNull();
    }
    const unread = narrativeFieldsFromAnalysis({ ...doc, x: { ...doc.x, status: "failed" } }, "complete");
    expect(unread.xCredibility).toBeNull();
    expect(unread.xAccountMadeForCoin).toBeNull();
    expect(unread.lineageKind).toBe("late_copy");
  });
});
