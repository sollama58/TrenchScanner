import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "ts_session";

export interface SessionPayload {
  userId: string;
  walletAddress: string;
}

export function createSessionSigner(jwtSecret: string, ttlHours: number) {
  const key = new TextEncoder().encode(jwtSecret);

  return {
    async sign(payload: SessionPayload): Promise<string> {
      return new SignJWT({ walletAddress: payload.walletAddress })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(payload.userId)
        .setIssuedAt()
        .setExpirationTime(`${ttlHours}h`)
        .sign(key);
    },

    async verify(token: string): Promise<SessionPayload | null> {
      try {
        const { payload } = await jwtVerify(token, key);
        if (typeof payload.sub !== "string" || typeof payload.walletAddress !== "string") {
          return null;
        }
        return { userId: payload.sub, walletAddress: payload.walletAddress };
      } catch {
        return null;
      }
    },
  };
}

export type SessionSigner = ReturnType<typeof createSessionSigner>;
