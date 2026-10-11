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
  if (cf && IP_LITERAL.test(cf.trim())) return rateLimitPrefix(cf.trim());
  return rateLimitPrefix(request.ip);
}

/**
 * An IPv6 address is keyed by its /64. A home line or a VPS is handed a whole /64 and can pick a
 * fresh source address per request from it, so keying the full address gave such a client a new
 * rate-limit bucket every time. IPv4 (and anything unparseable) is returned as is.
 */
export function rateLimitPrefix(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return ip;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
