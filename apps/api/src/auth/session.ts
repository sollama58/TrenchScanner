import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "ts_session";

/**
 * The session tokens a request carries, the cookie first and then an `Authorization: Bearer`
 * header.
 *
 * The header is the fallback for browsers that refuse the cookie. While the dashboard and this API
 * sit on different sites (two onrender.com hosts), the cookie is third-party, and Safari, Brave,
 * Edge with strict tracking prevention or InPrivate, and any browser set to block third-party
 * cookies drop it without an error: sign-in "works" and the very next request is signed out. The
 * dashboard then keeps the token itself and sends it here instead (see apps/web/src/session.ts).
 * A header is never attached by the browser on its own, so it adds no CSRF exposure.
 *
 * Both are returned so a stale cookie can't shadow a valid header. Anything else in the header
 * (the stats routes' STATS_API_TOKEN, say) just fails verification and reads as no session.
 */
export function sessionTokens(request: {
  cookies: Record<string, string | undefined>;
  headers: { authorization?: string };
}): string[] {
  const tokens: string[] = [];
  const cookie = request.cookies[SESSION_COOKIE_NAME];
  if (cookie) tokens.push(cookie);
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? "")?.[1];
  if (bearer && bearer !== cookie) tokens.push(bearer);
  return tokens;
}

export interface SessionPayload {
  userId: string;
  walletAddress: string;
  /**
   * Present only on a session created by scanning a pairing QR. It names the LinkedDevice row
   * this session belongs to, which is what makes it revocable: the token itself cannot be
   * withdrawn once signed, so resolveSession looks the device up and refuses a revoked one.
   */
  deviceId?: string;
  /**
   * Browser sessions only: the User.sessionVersion this token was issued under. Signing out bumps
   * the user's version, and resolveSession refuses any token carrying an older one. Tokens issued
   * before this claim existed read as 0, the column's starting value.
   */
  sessionVersion?: number;
}

/**
 * How long a paired-phone JWT is signed for. Long, because a linked device is meant to last until
 * someone revokes it - but NOT infinite, because a JWT is the one credential that cannot be
 * recalled, and an unbounded one would outlive the database row that governs it. Revocation is
 * immediate regardless (see resolveSession); this is only the backstop for a token whose device
 * row has since been pruned.
 */
const DEVICE_SESSION_TTL_HOURS = 365 * 24;

export function createSessionSigner(jwtSecret: string, ttlHours: number) {
  const key = new TextEncoder().encode(jwtSecret);

  return {
    async sign(payload: SessionPayload): Promise<string> {
      const claims: Record<string, string | number> = { walletAddress: payload.walletAddress };
      if (payload.deviceId) claims.deviceId = payload.deviceId;
      else claims.sv = payload.sessionVersion ?? 0;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(payload.userId)
        .setIssuedAt()
        .setExpirationTime(`${payload.deviceId ? DEVICE_SESSION_TTL_HOURS : ttlHours}h`)
        .sign(key);
    },

    async verify(token: string): Promise<SessionPayload | null> {
      try {
        const { payload } = await jwtVerify(token, key);
        if (typeof payload.sub !== "string" || typeof payload.walletAddress !== "string") {
          return null;
        }
        return {
          userId: payload.sub,
          walletAddress: payload.walletAddress,
          deviceId: typeof payload.deviceId === "string" ? payload.deviceId : undefined,
          sessionVersion: typeof payload.sv === "number" ? payload.sv : 0,
        };
      } catch {
        return null;
      }
    },
  };
}

export type SessionSigner = ReturnType<typeof createSessionSigner>;

/**
 * Every session token on the request that verifies (signature and expiry), cookie first.
 *
 * All of them, not just the first: a cookie can verify and still be dead (signed out, so its
 * sessionVersion is behind, or a revoked device), and stopping at it let that cookie shadow a
 * perfectly good header. The auth hooks try each in turn - see resolveSession in server.ts.
 */
export async function verifyRequestSessions(
  signer: SessionSigner,
  request: Parameters<typeof sessionTokens>[0],
): Promise<SessionPayload[]> {
  const sessions: SessionPayload[] = [];
  for (const token of sessionTokens(request)) {
    const session = await signer.verify(token);
    if (session) sessions.push(session);
  }
  return sessions;
}
