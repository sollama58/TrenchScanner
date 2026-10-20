import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { ipRateLimitKey } from "../clientIp.js";
import { prisma, type Env } from "@trenchscanner/core";
import {
  PASS_TTL_SECONDS,
  TWO_FACTOR_ACTIONS,
  base32,
  checkSecondFactor,
  factorFields,
  finishPasskeyRegistration,
  hasPass,
  issuePass,
  matchTotp,
  newBackupCodes,
  openSecret,
  otpauthUrl,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  registrationJson,
  sealSecret,
  twoFactorState,
  type TwoFactorAction,
  type TwoFactorState,
} from "../twoFactor.js";
import { signedInRecently, type SessionPayload } from "../auth/session.js";

/**
 * /auth/2fa: the signed-in user's own two-factor (twoFactor.ts). Everything here is about the
 * session's own account. Changing it needs a browser sign-in from the last few minutes, never a
 * paired phone, and once two-factor is on, a "manage" pass too.
 */

const RATE_LIMIT = { max: 30, timeWindow: "1 minute", keyGenerator: ipRateLimitKey };
const PASS_ACTIONS = [...TWO_FACTOR_ACTIONS, "manage"] as const;

/**
 * Why this session may not change two-factor at all, whatever pass it has (user decisions
 * 2026-10-20). A paired phone never can: it can't sign with the wallet, and a phone paired from a
 * stolen session must not be able to lock the owner out. A browser can only within
 * RECENT_SIGN_IN_MS of its sign-in. The codes are what the dashboard reads to say which.
 */
type ChangeBlock = "paired_phone" | "sign_in_again";
const CHANGE_REFUSALS: Record<ChangeBlock, string> = {
  paired_phone: "Change two-factor from your computer. A paired phone can't change it.",
  sign_in_again: "Sign in again to change two-factor. Changes need a sign-in from the last 10 minutes.",
};

function changeBlock(session: SessionPayload): ChangeBlock | null {
  if (session.deviceId) return "paired_phone";
  return signedInRecently(session) ? null : "sign_in_again";
}

export async function registerTwoFactorRoutes(app: FastifyInstance, opts: { env: Env }) {
  const { env } = opts;
  app.addHook("preHandler", app.authenticate);

  /**
   * Whether this session may change two-factor now: the account's state when it may; when not,
   * it has answered 403, with `code` (changeBlock) or with the "manage" ask once two-factor is on.
   */
  async function mayManage(
    request: Parameters<typeof hasPass>[1],
    reply: FastifyReply,
    userId: string,
  ): Promise<TwoFactorState | null> {
    const block = changeBlock(request.user!);
    if (block) {
      void reply.code(403).send({ error: CHANGE_REFUSALS[block], code: block });
      return null;
    }
    const state = await twoFactorState(userId);
    if (!state.enabled || (await hasPass(env, request, userId, "manage", state.epoch))) return state;
    void reply.code(403).send({ error: "Two-factor check needed", twoFactor: { action: "manage" } });
    return null;
  }

  app.get("/", async (request) => {
    const state = await twoFactorState(request.user!.userId);
    return {
      ...state,
      buyOverLamports: state.buyOverLamports?.toString() ?? null,
      choices: TWO_FACTOR_ACTIONS,
      // Why changes here would be refused right now, so Settings can say so up front.
      changeBlocked: changeBlock(request.user!),
    };
  });

  // ── Checking: a pass for one action ──
  app.post("/passkey-options", { config: { rateLimit: RATE_LIMIT } }, async (request, reply) => {
    const out = await passkeyAuthenticationOptions(env, request.user!.userId, request.headers.origin);
    if (!out) return reply.code(404).send({ error: "No passkey on this account" });
    return out;
  });

  app.post("/verify", { config: { rateLimit: RATE_LIMIT } }, async (request, reply) => {
    const parsed = z.object({ action: z.enum(PASS_ACTIONS), ...factorFields }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    const userId = request.user!.userId;
    const result = await checkSecondFactor(env, userId, parsed.data, request.headers.origin);
    if (!result.ok) return reply.code(401).send({ error: result.reason });
    return {
      pass: await issuePass(
        env,
        userId,
        parsed.data.action as TwoFactorAction,
        (await twoFactorState(userId)).epoch,
      ),
      ttlSeconds: PASS_TTL_SECONDS,
    };
  });

  // ── Authenticator app ──
  app.post("/totp/setup", { config: { rateLimit: RATE_LIMIT } }, async (request, reply) => {
    const userId = request.user!.userId;
    if (!(await mayManage(request, reply, userId))) return;
    const secret = randomBytes(20);
    await prisma.twoFactorSettings.upsert({
      where: { userId },
      update: { pendingTotpSecret: sealSecret(env, userId, secret) },
      create: { userId, pendingTotpSecret: sealSecret(env, userId, secret) },
    });
    const key = base32(secret);
    // The label names the app, never the wallet (user rule 2026-10-18: wallets stay private).
    return { secret: key, otpauthUrl: otpauthUrl(key, "account") };
  });

  app.post("/totp/confirm", { config: { rateLimit: RATE_LIMIT } }, async (request, reply) => {
    const parsed = z.object({ code: z.string().max(12) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    const userId = request.user!.userId;
    if (!(await mayManage(request, reply, userId))) return;
    const settings = await prisma.twoFactorSettings.findUnique({ where: { userId } });
    if (!settings?.pendingTotpSecret) return reply.code(400).send({ error: "Start the setup again." });
    const step = matchTotp(openSecret(env, userId, settings.pendingTotpSecret), parsed.data.code.trim());
    if (step === null)
      return reply.code(401).send({ error: "That code didn't match. Check the time on your phone." });
    const wasOn = (await twoFactorState(userId)).enabled;
    await prisma.twoFactorSettings.update({
      where: { userId },
      data: { totpSecret: settings.pendingTotpSecret, pendingTotpSecret: null, lastTotpStep: step },
    });
    // Backup codes come with the first factor; a second one keeps the codes already given.
    return { ok: true, backupCodes: wasOn ? null : await newBackupCodes(env, userId) };
  });

  app.delete("/totp", async (request, reply) => {
    const userId = request.user!.userId;
    if (!(await mayManage(request, reply, userId))) return;
    await prisma.twoFactorSettings.updateMany({
      where: { userId },
      data: { totpSecret: null, pendingTotpSecret: null, lastTotpStep: null },
    });
    await clearCodesIfOff(userId);
    return { ok: true };
  });

  // ── Passkeys ──
  app.post("/passkey/register-options", { config: { rateLimit: RATE_LIMIT } }, async (request, reply) => {
    const userId = request.user!.userId;
    if (!(await mayManage(request, reply, userId))) return;
    const out = await passkeyRegistrationOptions(
      env,
      userId,
      "TrenchScanner account",
      request.headers.origin,
    );
    if (!out) return reply.code(400).send({ error: "Passkeys work only on the TrenchScanner site itself." });
    return out;
  });

  app.post("/passkey/register", { config: { rateLimit: RATE_LIMIT } }, async (request, reply) => {
    const parsed = z
      .object({
        token: z.string().max(2048),
        response: registrationJson,
        name: z.string().max(60).default(""),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    const userId = request.user!.userId;
    if (!(await mayManage(request, reply, userId))) return;
    if ((await prisma.twoFactorPasskey.count({ where: { userId } })) >= 10)
      return reply.code(400).send({ error: "That's the most passkeys an account can have." });
    const wasOn = (await twoFactorState(userId)).enabled;
    const ok = await finishPasskeyRegistration(
      env,
      userId,
      parsed.data.token,
      parsed.data.response,
      parsed.data.name,
      request.headers.origin,
    );
    if (!ok) return reply.code(400).send({ error: "That passkey couldn't be added. Try again." });
    await prisma.twoFactorSettings.upsert({ where: { userId }, update: {}, create: { userId } });
    return { ok: true, backupCodes: wasOn ? null : await newBackupCodes(env, userId) };
  });

  app.delete("/passkey/:id", async (request, reply) => {
    const userId = request.user!.userId;
    if (!(await mayManage(request, reply, userId))) return;
    const { id } = request.params as { id: string };
    await prisma.twoFactorPasskey.deleteMany({ where: { id: String(id).slice(0, 64), userId } });
    await clearCodesIfOff(userId);
    return { ok: true };
  });

  // ── Choices and backup codes ──
  app.put("/actions", async (request, reply) => {
    const parsed = z
      .object({
        actions: z.array(z.enum(TWO_FACTOR_ACTIONS)).max(TWO_FACTOR_ACTIONS.length),
        // SOL, for "buyOver": 0.01 to 1000.
        buyOverSol: z.number().min(0.01).max(1000).nullable().default(null),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    const userId = request.user!.userId;
    if (!(await mayManage(request, reply, userId))) return;
    const actions = [...new Set([...parsed.data.actions, "export"])];
    if (actions.includes("buyOver") && parsed.data.buyOverSol === null)
      return reply.code(400).send({ error: "Set the buy size that asks." });
    const buyOverLamports =
      parsed.data.buyOverSol === null ? null : BigInt(Math.round(parsed.data.buyOverSol * 1e9));
    await prisma.twoFactorSettings.upsert({
      where: { userId },
      update: { actions, buyOverLamports },
      create: { userId, actions, buyOverLamports },
    });
    return { ok: true, actions };
  });

  app.post("/backup-codes", { config: { rateLimit: RATE_LIMIT } }, async (request, reply) => {
    const userId = request.user!.userId;
    const state = await mayManage(request, reply, userId);
    if (!state) return;
    if (!state.enabled) return reply.code(400).send({ error: "Turn on two-factor first." });
    return { backupCodes: await newBackupCodes(env, userId) };
  });

  /** With no app and no passkey left, two-factor is off: the codes it gave go too. */
  async function clearCodesIfOff(userId: string) {
    if (!(await twoFactorState(userId)).enabled)
      await prisma.twoFactorBackupCode.deleteMany({ where: { userId } });
  }
}
