import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bs58 from "bs58";
import { prisma, type Env } from "@trenchscanner/core";
import { issueNonce, verifyAndConsumeNonce } from "../auth/siws.js";
import { SESSION_COOKIE_NAME } from "../auth/session.js";

const nonceQuerySchema = z.object({
  wallet: z.string().refine(isValidSolanaAddress, "wallet must be a valid base58 Solana public key"),
});

const verifyBodySchema = z.object({
  walletAddress: z.string().refine(isValidSolanaAddress, "walletAddress must be a valid base58 Solana public key"),
  nonce: z.string().min(1),
  signature: z.string().min(1),
});

export async function registerAuthRoutes(app: FastifyInstance, opts: { env: Env }) {
  app.get("/nonce", async (request, reply) => {
    const parsed = nonceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { nonce, message, expiresAt } = await issueNonce(parsed.data.wallet);
    return { nonce, message, expiresAt };
  });

  app.post("/verify", async (request, reply) => {
    const parsed = verifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { walletAddress, nonce, signature } = parsed.data;

    const result = await verifyAndConsumeNonce({ walletAddress, nonce, signature });
    if (!result.ok) {
      return reply.code(401).send({ error: result.reason });
    }

    const user = await prisma.user.upsert({
      where: { walletAddress },
      create: { walletAddress },
      update: {},
    });

    const token = await app.sessionSigner.sign({ userId: user.id, walletAddress: user.walletAddress });
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      // Kept in sync with the JWT's own expiry (see createSessionSigner) - a mismatch here would
      // mean the cookie either outlives the token it holds or expires before it does.
      maxAge: opts.env.SESSION_TTL_HOURS * 60 * 60,
    });

    return { id: user.id, walletAddress: user.walletAddress, createdAt: user.createdAt };
  });

  app.post("/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.userId } });
    return { id: user.id, walletAddress: user.walletAddress, createdAt: user.createdAt };
  });
}

function isValidSolanaAddress(value: string): boolean {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}
