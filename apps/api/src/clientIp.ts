import type { FastifyRequest } from "fastify";

/** An IPv4 or IPv6 literal - the only shape a client-IP header is trusted to carry. */
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)$/;

/**
 * The caller's real IP, for rate limiting unauthenticated traffic.
 *
 * Not request.ip: with `trustProxy: true` that is the LEFT-most X-Forwarded-For entry, and the
 * client writes that one - the proxies in front of us append to the header rather than replace
 * it - so rotating a fake X-Forwarded-For per request got a fresh rate-limit bucket every time.
 * trustProxy stays on because the cookie logic needs X-Forwarded-Proto/Host.
 *
 * Production sits behind Cloudflare (Render's edge; responses carry `server: cloudflare` and a
 * cf-ray), and Cloudflare sets CF-Connecting-IP itself, overwriting any value the client sent.
 * Where it is absent this falls back to request.ip, the old behaviour - not to the socket peer,
 * which behind a proxy is the proxy itself and would put every anonymous caller in one bucket.
 */
export function clientIp(request: FastifyRequest): string {
  const header = request.headers["cf-connecting-ip"];
  const cf = Array.isArray(header) ? header[0] : header;
  if (cf && IP_LITERAL.test(cf.trim())) return cf.trim();
  return request.ip;
}
