import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { LruCache, fetchXPreview, parseXLink, pictureUrl, xLinkFromKey, xLinkKey } from "./xPreview.js";
import { registerXPreviewRoutes } from "./routes/xPreview.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PROFILE = {
  code: 200,
  user: {
    screen_name: "coin",
    name: "Coin",
    description: "the coin",
    followers: 1200,
    following: 3,
    tweets: 40,
    joined: "Tue Mar 21 20:50:14 +0000 2006",
    avatar_url: "https://pbs.twimg.com/profile_images/1/abc_normal.jpg",
    banner_url: "https://pbs.twimg.com/profile_banners/12/1742427520",
    verification: { verified: true },
  },
};

const POST = {
  code: 200,
  tweet: {
    text: "gm",
    created_timestamp: 1142974214,
    replies: 1,
    retweets: 2,
    likes: 3,
    views: null,
    author: {
      screen_name: "coin",
      name: "Coin",
      avatar_url: "https://pbs.twimg.com/profile_images/1/abc_200x200.jpg",
    },
    media: {
      all: [
        {
          type: "video",
          url: "https://video.twimg.com/x.mp4",
          thumbnail_url: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg",
        },
      ],
    },
  },
};

describe("parseXLink", () => {
  it("reads profiles, posts and communities in any of X's spellings", () => {
    expect(parseXLink("https://x.com/coin")).toEqual({ kind: "profile", handle: "coin" });
    expect(parseXLink("https://twitter.com/Coin/")).toEqual({ kind: "profile", handle: "Coin" });
    expect(parseXLink("https://www.x.com/coin?s=21")).toEqual({ kind: "profile", handle: "coin" });
    expect(parseXLink("https://x.com/coin/status/123?s=20")).toEqual({
      kind: "post",
      handle: "coin",
      id: "123",
    });
    expect(parseXLink("https://x.com/i/status/123")).toEqual({ kind: "post", handle: "i", id: "123" });
    expect(parseXLink("https://x.com/i/web/status/123")).toEqual({ kind: "post", handle: "i", id: "123" });
    expect(parseXLink("https://x.com/i/communities/456")).toEqual({ kind: "community", id: "456" });
  });

  it("refuses other sites and X pages that aren't an account", () => {
    expect(parseXLink("https://example.com/coin")).toBeNull();
    expect(parseXLink("https://x.com.evil.io/coin")).toBeNull();
    expect(parseXLink("https://x.com/search?q=coin")).toBeNull();
    expect(parseXLink("https://x.com/hashtag/coin")).toBeNull();
    expect(parseXLink("https://x.com/")).toBeNull();
    expect(parseXLink("https://x.com/coin/status/abc")).toBeNull();
    expect(parseXLink("javascript:alert(1)")).toBeNull();
    expect(parseXLink("not a url")).toBeNull();
  });

  it("keys one entry per account or post, and reads keys back", () => {
    expect(xLinkKey({ kind: "profile", handle: "Coin" })).toBe("p.coin");
    expect(xLinkKey({ kind: "post", handle: "coin", id: "9" })).toBe("s.9");
    expect(xLinkFromKey("p.coin")).toEqual({ kind: "profile", handle: "coin" });
    expect(xLinkFromKey("s.9")).toEqual({ kind: "post", handle: "i", id: "9" });
    expect(xLinkFromKey("p.../etc")).toBeNull();
    expect(xLinkFromKey("c.1")).toBeNull();
  });
});

describe("pictureUrl", () => {
  it("keeps X's picture host only, at the sizes a card shows", () => {
    expect(pictureUrl("https://pbs.twimg.com/profile_images/1/a_normal.jpg", "avatar")).toBe(
      "https://pbs.twimg.com/profile_images/1/a_200x200.jpg",
    );
    expect(pictureUrl("https://pbs.twimg.com/profile_banners/12/34", "banner")).toBe(
      "https://pbs.twimg.com/profile_banners/12/34/600x200",
    );
    expect(pictureUrl("https://pbs.twimg.com/media/a.jpg?name=orig", "media")).toBe(
      "https://pbs.twimg.com/media/a.jpg?name=small",
    );
    expect(pictureUrl("https://evil.io/a.jpg", "avatar")).toBeNull();
    expect(pictureUrl("http://pbs.twimg.com/profile_images/1/a.jpg", "avatar")).toBeNull();
    expect(
      pictureUrl("https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png", "avatar"),
    ).toBeNull();
    expect(pictureUrl(null, "avatar")).toBeNull();
  });
});

describe("fetchXPreview", () => {
  it("reads a profile into the preview, with this API's picture paths", async () => {
    const fetchImpl = vi.fn(async () => json(PROFILE)) as unknown as typeof fetch;
    const { preview, pictures } = await fetchXPreview({ kind: "profile", handle: "Coin" }, fetchImpl);
    expect(preview).toMatchObject({
      kind: "profile",
      handle: "coin",
      verified: true,
      followers: 1200,
      joined: "2006-03-21T20:50:14.000Z",
      avatar: "/x-preview/image/p.coin/avatar",
      banner: "/x-preview/image/p.coin/banner",
    });
    expect(pictures.avatar).toBe("https://pbs.twimg.com/profile_images/1/abc_200x200.jpg");
  });

  it("reads a post with a video's still as its picture", async () => {
    const fetchImpl = vi.fn(async () => json(POST)) as unknown as typeof fetch;
    const { preview, pictures } = await fetchXPreview({ kind: "post", handle: "coin", id: "5" }, fetchImpl);
    expect(preview).toMatchObject({ kind: "post", text: "gm", likes: 3, views: null, mediaKind: "video" });
    expect(preview.kind === "post" && preview.media).toBe("/x-preview/image/s.5/media");
    expect(pictures.media).toBe("https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg?name=small");
  });

  it("tells a missing account apart from an outage", async () => {
    const missing = vi.fn(async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    await expect(fetchXPreview({ kind: "profile", handle: "nobody" }, missing)).rejects.toThrow("");
    const down = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchXPreview({ kind: "profile", handle: "coin" }, down)).rejects.toThrow("503");
  });
});

describe("LruCache", () => {
  it("drops the least recently used entry, expired entries and anything over its size", () => {
    let now = 0;
    const c = new LruCache<string>(
      2,
      10,
      (v) => v.length,
      () => now,
    );
    c.set("a", "1", 100);
    c.set("b", "2", 100);
    c.get("a");
    c.set("c", "3", 100);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("1");
    c.set("big", "x".repeat(11), 100);
    expect(c.get("big")).toBeUndefined();
    now = 200;
    expect(c.get("a")).toBeUndefined();
  });
});

describe("GET /x-preview", () => {
  async function app(fetchImpl: typeof fetch) {
    const a = Fastify();
    await a.register(registerXPreviewRoutes, { prefix: "/x-preview", fetchImpl });
    return a;
  }

  it("answers a preview and reads FxTwitter once for many hovers", async () => {
    const fetchImpl = vi.fn(async () => json(PROFILE)) as unknown as typeof fetch;
    const a = await app(fetchImpl);
    const url = `/x-preview?url=${encodeURIComponent("https://x.com/coin")}`;
    const [r1, r2] = await Promise.all([a.inject(url), a.inject(url)]);
    const r3 = await a.inject(`/x-preview?url=${encodeURIComponent("https://twitter.com/COIN")}`);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ kind: "profile", handle: "coin" });
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses anything but an X link, and says when the account is gone", async () => {
    const fetchImpl = vi.fn(async () => json({ code: 404 }, 404)) as unknown as typeof fetch;
    const a = await app(fetchImpl);
    expect((await a.inject(`/x-preview?url=${encodeURIComponent("https://example.com")}`)).statusCode).toBe(
      400,
    );
    expect((await a.inject("/x-preview")).statusCode).toBe(400);
    expect((await a.inject(`/x-preview?url=${encodeURIComponent("https://x.com/gone")}`)).statusCode).toBe(
      404,
    );
  });

  it("serves only pictures a preview named", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const u = String(input);
      if (u.startsWith("https://api.fxtwitter.com/")) return json(PROFILE);
      if (u === "https://pbs.twimg.com/profile_images/1/abc_200x200.jpg")
        return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const a = await app(fetchImpl);
    const ok = await a.inject("/x-preview/image/p.coin/avatar");
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/jpeg");
    expect(ok.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(ok.rawPayload.equals(jpeg)).toBe(true);
    expect((await a.inject("/x-preview/image/p.coin/media")).statusCode).toBe(404);
    expect((await a.inject("/x-preview/image/x.evil/avatar")).statusCode).toBe(404);
    expect((await a.inject("/x-preview/image/p.coin/other")).statusCode).toBe(404);
  });
});
