import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { z } from "zod";
import { prisma, walletTag } from "@trenchscanner/core";

/**
 * A fresh wallet signature for every trading bot action (user decision after the 2026-10-16
 * security audit). A session alone, however it was stolen (a copied cookie, an XSS, a token from
 * localStorage), can no longer move the bot: no settings save, sell, withdrawal, wallet creation
 * or trade-alert change happens without the admin's wallet signing that exact request.
 *
 * The flow: the dashboard posts the request it is about to make to /trading/confirm, which keeps a
 * single-use nonce (an AuthNonce row, prefixed so it can never be a sign-in nonce) and answers
 * with the text to sign. That text names the action and a digest of the method, path and body.
 * The dashboard has the wallet sign it and sends the request with `confirmation: { nonce,
 * signature }` in its body. The route rebuilds the text from the request it actually received, so
 * a signature for one request is worthless for any other, and spends the nonce.
 *
 * Paper trading signs nothing and needs none of this.
 *
 * The same flow guards the admin actions a stolen session could do the most harm with (user
 * decision after the 2026-10-18 admin panel audit): the AI reviewer switch to "live", a model
 * restore, and a table backup download. See requireAdminConfirmation.
 */

/** How long a confirmation may sit between the challenge and the request it signs. */
export const TRADE_CONFIRM_TTL_MS = 5 * 60_000;
const NONCE_PREFIX = "trade:";

export const confirmationSchema = z.object({
  nonce: z.string().min(1).max(128),
  signature: z.string().min(1).max(100),
});

const challengeSchema = z.object({
  // GET only for a download (an admin table backup or database dump), whose confirmation rides in
  // the query.
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  // Or pairing a phone (/auth/link/code): the phone gets a year-long session (full admin with no
  // signatures of its own, for an admin), so minting one is signed for like the actions it could do.
  // Dots for a dump's file name (db-dumps/trenchscanner-<stamp>.dump/download), never two in a row.
  path: z
    .string()
    .regex(/^\/((trading|admin)\/[A-Za-z0-9/_.-]{1,200}|auth\/link\/code)$/)
    .refine((p) => !p.includes(".."), "no dot segments"),
  body: z.record(z.string(), z.unknown()).default({}),
});

/** JSON with object keys sorted at every depth, so equal bodies always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The request digest the signed text carries: method, path and body, without the confirmation. */
export function requestDigest(method: string, path: string, body: Record<string, unknown>): string {
  const { confirmation: _confirmation, ...rest } = body;
  return createHash("sha256")
    .update(`${method.toUpperCase()} ${path}\n${canonicalJson(rest)}`)
    .digest("hex");
}

/** What the wallet is asked to approve, in words, from the route. */
export function actionLabel(method: string, path: string): string {
  if (path === "/auth/link/code")
    return "Pair a phone with this wallet (it stays signed in until you sign out)";
  if (path.startsWith("/admin/")) {
    const rest = path.slice("/admin/".length);
    if (rest === "ai/switch") return "Change the AI reviewer switch";
    if (/^model-backups\/[^/]+\/restore$/.test(rest)) return "Restore models from a backup";
    if (/^table-backups\/[^/]+\/download$/.test(rest)) return "Download a table backup (every user's data)";
    if (/^db-dumps\/[^/]+\/download$/.test(rest))
      return "Download a full database backup (every user's data)";
    return `${method.toUpperCase()} ${path}`;
  }
  const server = path.startsWith("/trading/server/");
  const rest = path.replace(/^\/trading\/(server\/)?/, "");
  const whose = server ? " (server wallet)" : "";
  if (rest === "bot") return `Change the trading bot's settings${whose}`;
  if (rest === "sell-all") return `Sell every position and pause the bot${whose}`;
  if (/^positions\/[^/]+\/sell$/.test(rest)) return `Sell one position${whose}`;
  if (rest === "withdraw") return `Withdraw SOL from the trading wallet${whose}`;
  if (rest === "wallet") return "Create the trading wallet";
  if (rest === "alerts") return "Change trade alerts";
  return `${method.toUpperCase()} ${path}`;
}

/** The exact text the wallet signs. Rebuilt on the server from the request it receives. */
export function confirmationMessage(input: {
  walletAddress: string;
  method: string;
  path: string;
  digest: string;
  nonce: string;
  issuedAt: Date;
}): string {
  return [
    input.path.startsWith("/admin/")
      ? "TrenchScanner admin: confirm this action"
      : input.path.startsWith("/auth/")
        ? "TrenchScanner: confirm this action"
        : "TrenchScanner trading bot: confirm this action",
    "",
    actionLabel(input.method, input.path),
    "",
    `Wallet: ${input.walletAddress}`,
    `Request: ${input.digest}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
  ].join("\n");
}

/** The request path as the route sees it, without a query string. */
function pathOf(request: FastifyRequest): string {
  return request.url.split("?")[0] ?? request.url;
}

/** POST /trading/confirm: a nonce and the text to sign for the request the dashboard is about to make. */
export async function issueTradeConfirmation(
  request: FastifyRequest,
  reply: FastifyReply,
  /** The request to sign for, when the route fixes it rather than reading it from the body. */
  fixed?: { method: "POST"; path: string; body: Record<string, unknown> },
) {
  const parsed = challengeSchema.safeParse(fixed ?? request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid confirmation request" });
  const walletAddress = request.user!.walletAddress;
  const nonce = `${NONCE_PREFIX}${randomBytes(16).toString("hex")}`;
  const row = await prisma.authNonce.create({
    data: { walletAddress, nonce, expiresAt: new Date(Date.now() + TRADE_CONFIRM_TTL_MS) },
    select: { createdAt: true },
  });
  const { method, path, body } = parsed.data;
  return {
    nonce,
    walletAddress,
    message: confirmationMessage({
      walletAddress,
      method,
      path,
      digest: requestDigest(method, path, body),
      nonce,
      issuedAt: row.createdAt,
    }),
  };
}

/**
 * Lets the request through (true) only with a valid, unspent confirmation signed by the session's
 * wallet for exactly this request; otherwise answers 428 with code "confirmation_required" (none
 * sent) or 403 (one that doesn't verify) and returns false.
 */
export async function requireTradeConfirmation(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  // A GET (a download) has no body: its confirmation comes in the query and it signs an empty one.
  const isGet = request.method === "GET";
  const body = isGet ? {} : ((request.body ?? {}) as Record<string, unknown>);
  const parsed = confirmationSchema.safeParse(isGet ? request.query : body.confirmation);
  if (!parsed.success) {
    await reply.code(428).send({
      error: pathOf(request).startsWith("/admin/")
        ? "Approve this in your wallet: this admin action needs a fresh signature."
        : pathOf(request).startsWith("/auth/")
          ? "Approve this in your wallet: pairing a phone needs a fresh signature."
          : "Approve this in your wallet: every trading bot action needs a fresh signature.",
      code: "confirmation_required",
    });
    return false;
  }
  const { nonce, signature } = parsed.data;
  const walletAddress = request.user!.walletAddress;
  const refuse = async (why: string) => {
    request.log.warn({ wallet: walletTag(walletAddress), why }, "trading confirmation refused");
    await reply.code(403).send({ error: `The wallet confirmation didn't check out (${why}). Try again.` });
    return false;
  };
  if (!nonce.startsWith(NONCE_PREFIX)) return refuse("not a trading confirmation");
  const row = await prisma.authNonce.findUnique({ where: { nonce } });
  if (!row || row.walletAddress !== walletAddress) return refuse("unknown confirmation");
  if (row.usedAt) return refuse("already used");
  if (row.expiresAt.getTime() < Date.now()) return refuse("expired");
  const message = confirmationMessage({
    walletAddress,
    method: request.method,
    path: pathOf(request),
    digest: requestDigest(request.method, pathOf(request), body),
    nonce,
    issuedAt: row.createdAt,
  });
  const valid = (() => {
    try {
      return nacl.sign.detached.verify(
        new TextEncoder().encode(message),
        bs58.decode(signature),
        bs58.decode(walletAddress),
      );
    } catch {
      return false;
    }
  })();
  if (!valid) return refuse("signature doesn't match this request");
  // Single use, settled in the database: two requests racing one signature can't both pass.
  const spent = await prisma.authNonce.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (spent.count !== 1) return refuse("already used");
  return true;
}

/**
 * requireTradeConfirmation for the admin actions that need one, except from a paired phone: an
 * admin's paired phone may do everything without signing (user decision, 2026-10-18), since it has
 * no wallet to sign with. Its sessions last at most ADMIN_SESSION_MAX_AGE_MS.
 */
export async function requireAdminConfirmation(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (request.user?.deviceId) return true;
  return requireTradeConfirmation(request, reply);
}
