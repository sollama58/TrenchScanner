import Fastify from "fastify";
import compress from "@fastify/compress";
import { describe, expect, it } from "vitest";
import { registerEtag } from "./etag.js";

const big = { rows: Array.from({ length: 400 }, (_, i) => ({ i, name: `row ${i}` })) };

async function app() {
  const a = Fastify();
  registerEtag(a);
  await a.register(compress, { global: true, threshold: 1024, encodings: ["gzip", "deflate"] });
  let body: unknown = big;
  a.get("/big", async () => body);
  a.get("/small", async () => ({ ok: true }));
  a.get("/nostore", async (_req, reply) => reply.header("Cache-Control", "no-store").send(big));
  a.get("/cached", async (_req, reply) => reply.header("Cache-Control", "private, max-age=15").send(big));
  a.get("/missing", async (_req, reply) => reply.code(404).send(big));
  a.post("/big", async () => big);
  return { a, set: (b: unknown) => (body = b) };
}

describe("registerEtag", () => {
  it("tags a large GET answer and answers an unchanged re-read with an empty 304", async () => {
    const { a } = await app();
    const first = await a.inject({ method: "GET", url: "/big" });
    expect(first.statusCode).toBe(200);
    const tag = first.headers.etag as string;
    expect(tag).toMatch(/^W\/".+"$/);
    expect(first.headers["cache-control"]).toBe("private, no-cache");

    const again = await a.inject({
      method: "GET",
      url: "/big",
      headers: { "if-none-match": tag, "accept-encoding": "gzip" },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    expect(again.headers.etag).toBe(tag);
    expect(again.headers["content-encoding"]).toBeUndefined();
  });

  it("sends the new body once the answer changes", async () => {
    const { a, set } = await app();
    const tag = (await a.inject({ method: "GET", url: "/big" })).headers.etag as string;
    set({ ...big, extra: 1 });
    const changed = await a.inject({ method: "GET", url: "/big", headers: { "if-none-match": tag } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ extra: 1 });
    expect(changed.headers.etag).not.toBe(tag);
  });

  it("hashes the JSON, not the compressed bytes: gzip and identity readers share a tag", async () => {
    const { a } = await app();
    const plain = await a.inject({ method: "GET", url: "/big" });
    const gz = await a.inject({ method: "GET", url: "/big", headers: { "accept-encoding": "gzip" } });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gz.headers.etag).toBe(plain.headers.etag);
  });

  it("matches a tag in a list, and a strong-form copy of it", async () => {
    const { a } = await app();
    const tag = (await a.inject({ method: "GET", url: "/big" })).headers.etag as string;
    const list = await a.inject({ method: "GET", url: "/big", headers: { "if-none-match": `"x", ${tag}` } });
    expect(list.statusCode).toBe(304);
    const strong = await a.inject({ method: "GET", url: "/big", headers: { "if-none-match": tag.slice(2) } });
    expect(strong.statusCode).toBe(304);
  });

  it("leaves small answers, no-store, errors and writes alone, and keeps a route's own Cache-Control", async () => {
    const { a } = await app();
    expect((await a.inject({ method: "GET", url: "/small" })).headers.etag).toBeUndefined();
    expect((await a.inject({ method: "GET", url: "/nostore" })).headers.etag).toBeUndefined();
    expect((await a.inject({ method: "GET", url: "/missing" })).headers.etag).toBeUndefined();
    expect((await a.inject({ method: "POST", url: "/big" })).headers.etag).toBeUndefined();
    const cached = await a.inject({ method: "GET", url: "/cached" });
    expect(cached.headers.etag).toBeDefined();
    expect(cached.headers["cache-control"]).toBe("private, max-age=15");
  });
});
