import { describe, expect, it, vi } from "vitest";
import { avatarHandle, biggerAvatarUrl, fetchXAvatar } from "./xAvatar.js";

const PIC = "https://pbs.twimg.com/profile_images/1878584793249583104/WMH0-IGY_normal.jpg";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const image = (bytes = 100, type = "image/jpeg") =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } });

describe("avatarHandle", () => {
  it("lower-cases a handle and drops its @, and refuses anything that isn't one", () => {
    expect(avatarHandle("@@Cupseyy")).toBe("cupseyy");
    expect(avatarHandle(" Decu0x ")).toBe("decu0x");
    expect(avatarHandle("<script>")).toBeNull();
    expect(avatarHandle(null)).toBeNull();
  });
});

describe("fetchXAvatar", () => {
  it("reads the 73px picture through FxTwitter", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("https://api.fxtwitter.com/") ? json({ user: { avatar_url: PIC } }) : image(),
    );
    const got = await fetchXAvatar("Cupseyy", fetchMock as unknown as typeof fetch);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://api.fxtwitter.com/Cupseyy",
      biggerAvatarUrl(PIC),
    ]);
    expect(biggerAvatarUrl(PIC)).toMatch(/_bigger\.jpg$/);
    expect(got).toMatchObject({ status: "ok", contentType: "image/jpeg" });
    expect(got.status === "ok" && got.hash).toHaveLength(12);
  });

  it("answers none for an unknown handle, X's default picture, or a picture off X's host", async () => {
    const run = (first: Response) =>
      fetchXAvatar("someone", (async (url: string) =>
        url.includes("fxtwitter") ? first : image()) as typeof fetch);
    expect(await run(new Response(null, { status: 302 }))).toEqual({ status: "none" });
    expect(await run(json({ code: 404 }, 404))).toEqual({ status: "none" });
    expect(
      await run(
        json({
          user: {
            avatar_url: "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
          },
        }),
      ),
    ).toEqual({ status: "none" });
    expect(
      await run(
        json({
          user: {
            avatar_url: "https://pbs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
          },
        }),
      ),
    ).toEqual({ status: "none" });
    expect(await run(json({ user: { avatar_url: "https://evil.example/x_normal.jpg" } }))).toEqual({
      status: "none",
    });
  });

  it("throws on a rate limit or outage, so the handle is tried again", async () => {
    await expect(
      fetchXAvatar("someone", (async () => json({}, 429)) as unknown as typeof fetch),
    ).rejects.toThrow(/429/);
  });

  it("refuses a body that isn't an image", async () => {
    const got = await fetchXAvatar("someone", (async (url: string) =>
      url.includes("fxtwitter")
        ? json({ user: { avatar_url: PIC } })
        : image(10, "text/html")) as unknown as typeof fetch);
    expect(got).toEqual({ status: "none" });
  });
});
