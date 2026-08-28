import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "ts_session";

export interface SessionPayload {
  userId: string;
  walletAddress: string;
  /**
   * Present only on a session created by scanning a pairing QR. It names the LinkedDevice row
   * this session belongs to, which is what makes it revocable: the token itself cannot be
   * withdrawn once signed, so resolveSession looks the device up and refuses a revoked one.
   */
  deviceId?: string;
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
      const claims: Record<string, string> = { walletAddress: payload.walletAddress };
      if (payload.deviceId) claims.deviceId = payload.deviceId;
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
        };
      } catch {
        return null;
      }
    },
  };
}

export type SessionSigner = ReturnType<typeof createSessionSigner>;
