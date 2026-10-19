import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Smaller answers aren't worth a hash: a 304 saves little more than its own headers. */
export const ETAG_MIN_BYTES = 4096;

/**
 * Weak ETags and 304s for GET answers, so a poll whose answer hasn't changed since the browser's
 * last copy gets an empty 304 instead of the whole body again. The dashboard polls its reports
 * every 30 s to 2 min (insights, models, the guest feed, health) while the server copy changes
 * every few minutes; each of those polls was a full download (perf audit 2026-10-19, F4).
 *
 * Browsers send If-None-Match on their own for a stored response that carries an ETag, and hand
 * fetch() the stored body on a 304, so the web app needs no change. Answers a route already marks
 * no-store are left alone. Answers with no Cache-Control get `private, no-cache`: the browser keeps
 * them and checks back every time, as it did before, and no shared cache keeps them.
 *
 * Must be added before @fastify/compress, so it hashes the JSON and a 304 is never compressed.
 */
export function registerEtag(app: FastifyInstance): void {
  // A callback hook, not an async one: an async onSend defers the send by a tick, and the auth
  // hooks that send a 401 without returning the reply would then let the route handler run on.
  app.addHook("onSend", (request, reply, payload, done) => done(null, withEtag(request, reply, payload)));
}

function withEtag(request: FastifyRequest, reply: FastifyReply, payload: unknown): unknown {
  if (request.method !== "GET" || reply.statusCode !== 200) return payload;
  if (typeof payload !== "string" && !Buffer.isBuffer(payload)) return payload;
  if (Buffer.byteLength(payload) < ETAG_MIN_BYTES || reply.getHeader("etag") !== undefined) return payload;
  const cacheControl = reply.getHeader("cache-control");
  if (typeof cacheControl === "string" && cacheControl.includes("no-store")) return payload;
  const tag = `W/"${createHash("sha1").update(payload).digest("base64url")}"`;
  reply.header("etag", tag);
  if (cacheControl === undefined) reply.header("cache-control", "private, no-cache");
  if (matches(request.headers["if-none-match"], tag)) {
    reply.code(304);
    reply.removeHeader("content-type");
    reply.removeHeader("content-length");
    return "";
  }
  return payload;
}

/** Whether an If-None-Match header names `tag` (weak comparison, as RFC 9110 says for GET). */
function matches(header: string | undefined, tag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const opaque = tag.slice(2);
  return header.split(",").some((t) => {
    const v = t.trim();
    return (v.startsWith("W/") ? v.slice(2) : v) === opaque;
  });
}
