import { describe, expect, it } from "vitest";
import {
  narrativeDepthCovers,
  narrativeFieldsFromAnalysis,
  normalizeSocialUrl,
  type TokenSageAnalysis,
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
