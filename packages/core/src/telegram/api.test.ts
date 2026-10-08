import { describe, expect, it } from "vitest";
import { FakeTelegramApi } from "./fakeApi.js";
import { TelegramApi, isPublicAddress } from "./api.js";

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

  it("measures the caption as Telegram does, without the markup", async () => {
    const api = new FakeTelegramApi(async () => image());
    // Well over 1024 characters of HTML, but under 1000 of text: still a caption.
    const html = `<a href="https://trenchscanner.app/?sage=${"m".repeat(200)}">${"y".repeat(990)}</a> &amp; &lt;b&gt;`;
    await api.sendAlert(5, { html, imageUrl: "https://cdn.example/a.png" });
    expect(api.calls.map((c) => c.method)).toEqual(["sendPhoto"]);
  });
});

describe("fetchImage safety", () => {
  it("refuses hosts that are not on the public internet", async () => {
    const seen: string[] = [];
    const api = new TelegramApi(
      "t",
      async (url) => {
        seen.push(String(url));
        return image();
      },
      async (host) => (host === "metadata.example" ? ["169.254.169.254"] : ["93.184.216.34"]),
    );
    for (const url of [
      "http://cdn.example/a.png",
      "https://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "https://[::ffff:10.0.0.1]/a.png",
      "https://10.1.2.3/a.png",
      "https://localhost/a.png",
      "https://api.internal/a.png",
      "https://worker/a.png",
      "https://cdn.example:8443/a.png",
      "https://user:pw@cdn.example/a.png",
      "https://metadata.example/a.png",
    ]) {
      expect(await api.fetchImage(url), url).toBeNull();
    }
    expect(seen).toEqual([]);
    expect(await api.fetchImage("https://cdn.example/a.png")).not.toBeNull();
  });

  it("checks every redirect hop", async () => {
    const seen: string[] = [];
    const api = new TelegramApi(
      "t",
      async (url) => {
        seen.push(String(url));
        if (String(url).includes("/hop"))
          return new Response(null, { status: 302, headers: { location: "https://10.0.0.5/x.png" } });
        if (String(url).includes("/ok"))
          return new Response(null, { status: 301, headers: { location: "/a.png" } });
        return image();
      },
      async () => ["93.184.216.34"],
    );
    expect(await api.fetchImage("https://cdn.example/hop")).toBeNull();
    expect(seen).toEqual(["https://cdn.example/hop"]);
    expect(await api.fetchImage("https://cdn.example/ok")).not.toBeNull();
    expect(seen.slice(1)).toEqual(["https://cdn.example/ok", "https://cdn.example/a.png"]);
  });

  it("stops reading a body that runs past the cap", async () => {
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const api = new TelegramApi(
      "t",
      async () => new Response(big, { headers: { "content-type": "image/png" } }),
      async () => ["93.184.216.34"],
    );
    expect(await api.fetchImage("https://cdn.example/a.png")).toBeNull();
    expect(pulled).toBeLessThan(20);
  });

  it("keeps the bot token out of a failed call's description", async () => {
    const api = new TelegramApi("123:secret", () =>
      Promise.reject(new Error("Failed to parse URL from https://api.telegram.org/bot123:secret/getMe")),
    );
    const result = await api.getMe();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("123:secret");
  });
});

describe("isPublicAddress", () => {
  it("tells public from private", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
    for (const a of [
      "10.0.0.1",
      "172.20.1.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "not-an-ip",
    ])
      expect(isPublicAddress(a), a).toBe(false);
  });
});
