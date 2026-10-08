import { describe, expect, it } from "vitest";
import { FakeTelegramApi } from "./fakeApi.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const image = (status = 200, type = "image/png", body: Uint8Array = png) =>
  new Response(status === 200 ? body : "nope", { status, headers: { "content-type": type } });

describe("sendAlert", () => {
  it("fetches the artwork and uploads it as the photo", async () => {
    const seen: string[] = [];
    const api = new FakeTelegramApi(async (url) => {
      seen.push(String(url));
      return image();
    });
    const result = await api.sendAlert(5, { html: "<b>hi</b>", imageUrl: "https://cdn.example/a.png" });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["https://cdn.example/a.png"]);
    const call = api.calls.find((c) => c.method === "sendPhoto")!;
    expect(call.params.photo).toBeInstanceOf(Blob);
    expect((call.params.photo as Blob).type).toBe("image/png");
    expect(await (call.params.photo as Blob).bytes()).toEqual(png);
    expect(call.params.caption).toBe("<b>hi</b>");
    expect(api.sent()).toEqual([{ chatId: "5", text: "<b>hi</b>", photo: "upload" }]);
  });

  it("hands Telegram the URL when the fetch fails, then falls back to text on a 400", async () => {
    for (const bad of [
      () => Promise.reject(new Error("ECONNRESET")),
      async () => image(429, "text/plain"),
      async () => image(200, "text/html"),
    ]) {
      const api = new FakeTelegramApi(bad as typeof fetch);
      await api.sendAlert(5, { html: "x", imageUrl: "https://cdn.example/a.png" });
      expect(api.sent().map((m) => m.photo)).toEqual(["https://cdn.example/a.png"]);
    }
    const api = new FakeTelegramApi(async () => image(200, "text/plain"));
    api.answers.set("sendPhoto", {
      ok: false,
      code: 400,
      description: "Bad Request: failed to get HTTP URL content",
    });
    const result = await api.sendAlert(5, { html: "x", imageUrl: "https://cdn.example/a.png" });
    expect(result.ok).toBe(true);
    expect(api.sent().map((m) => m.photo)).toEqual(["https://cdn.example/a.png", null]);
  });

  it("sends text alone without artwork or when the caption would be too long", async () => {
    const api = new FakeTelegramApi(async () => image());
    await api.sendAlert(5, { html: "x", imageUrl: null });
    await api.sendAlert(5, { html: "y".repeat(1025), imageUrl: "https://cdn.example/a.png" });
    expect(api.calls.map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
  });
});
