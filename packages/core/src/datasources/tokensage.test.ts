import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TokenSageClient,
  tokenSageHints,
  narrativeDepthCovers,
  narrativeFieldsFromAnalysis,
  normalizeSocialUrl,
  storableAnalysis,
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
 * Real responses captured from TokenSage (rules 0.8.0) running locally against its fake chain:
 * GET /v1/tokens/{ca} at full and basic depth, a hints-only mint that isn't on-chain yet (a
 * partial answer), and a batch with a complete, an invalid and a pending item.
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
      xFit: 0,
      xVerdict: "unrelated",
      rulesVersion: "0.8.0-full",
    });
    expect(f.categories.slice(0, 2)).toEqual([
      { label: "animal", confidence: 0.97 },
      { label: "animal/squirrel", confidence: 0.97 },
    ]);
    expect(f.categories).toHaveLength(8);
    expect(f.flags).toEqual(["copycat", "earlier_same_name", "borrowed_narrative", "x_content_mismatch"]);
    expect(f.summary).toMatch(/^Peanut the Squirrel 2\.0 \(\$PNUT2\)/);
    expect(f.summary!.length).toBeLessThanOrEqual(500);
    expect(f.analyzedAt).toBeInstanceOf(Date);
  });

  it("reads a basic answer, where the X post was not fetched", () => {
    const { analysis } = fixture("basic");
    expect(analysis.x?.status).toBe("not_fetched");
    const f = narrativeFieldsFromAnalysis(analysis, "complete");
    expect(f).toMatchObject({ depth: "basic", xFit: null, xVerdict: null, flags: ["copycat"] });
    expect(f.categories[0]).toEqual({ label: "derivative", confidence: 0.97 });
  });

  it("reads a partial answer made from our hints, with no market data and no referent", () => {
    const { status, analysis } = fixture("partial");
    expect(status).toBe("partial");
    expect(analysis.market?.pair).toBeNull();
    expect(analysis.caveats).toContain("hints: metadata supplied by caller");
    const f = narrativeFieldsFromAnalysis(analysis, "partial");
    expect(f).toMatchObject({
      depth: "basic",
      status: "partial",
      referentLabel: null,
      referentKind: null,
      flags: ["non_pumpfun"],
      xFit: null,
    });
    expect(f.categories.map((c) => c.label)).toContain("animal/frog");
  });

  it("matches the batch item shapes we branch on", () => {
    const { items } = fixture("batch");
    expect(items.map((i) => [i.status, i.error ?? null, i.job_id ?? null])).toEqual([
      ["complete", null, null],
      ["invalid", "not a Solana address (length)", null],
      ["pending", null, 17],
    ]);
    expect(narrativeFieldsFromAnalysis(items[0]!.analysis!, "complete").xVerdict).toBe("unrelated");
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
