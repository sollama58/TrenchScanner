import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma, prisma } from "@trenchscanner/core";

/** A body bigger than this is recorded only by its keys: a backup import is megabytes of model. */
const MAX_DETAIL_CHARS = 4_000;

/** Reads that hand out every user's data: recorded like writes (the query is left out). */
const AUDITED_READS = [
  "/table-backups/:id/download",
  "/db-dumps/:name/download",
  "/model-backups/:id/download",
  "/subscriptions/export",
];

/** The route's params and a capped copy of its JSON body, without the wallet signature. */
export function actionDetail(
  request: Pick<FastifyRequest, "params" | "body"> & { headers?: FastifyRequest["headers"] },
): Prisma.InputJsonValue | null {
  const params = (request.params ?? {}) as Record<string, unknown>;
  const raw = request.body;
  let body: unknown = null;
  const declared = Number(request.headers?.["content-length"] ?? 0);
  if (raw && typeof raw === "object" && !Buffer.isBuffer(raw) && declared > MAX_DETAIL_CHARS * 4) {
    // Too big to keep anyway: not serialised a second time just to be measured.
    body = { keys: Object.keys(raw as Record<string, unknown>), bytes: declared };
  } else if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) {
    const { confirmation: _confirmation, ...rest } = raw as Record<string, unknown>;
    const text = JSON.stringify(rest);
    body = text.length <= MAX_DETAIL_CHARS ? rest : { keys: Object.keys(rest), chars: text.length };
  } else if (Buffer.isBuffer(raw)) {
    body = { bytes: raw.length };
  }
  if (Object.keys(params).length === 0 && body === null) return null;
  return JSON.parse(JSON.stringify({ params, body })) as Prisma.InputJsonValue;
}

/**
 * Records every admin wallet's write (and the AUDITED_READS downloads) in AdminAction once it has been answered, whatever the
 * answer: a refused attempt is worth knowing about too. A non-admin's request (the gate's 403)
 * is not recorded, so nobody else can fill the table. A failed write is logged and never fails
 * the request.
 */
export function recordAdminActions(app: FastifyInstance, admins: ReadonlySet<string>) {
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? request.url.split("?")[0] ?? request.url;
    const read = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
    if (read && !(request.method === "GET" && AUDITED_READS.some((r) => route.endsWith(r)))) return;
    const user = request.user;
    if (!user || !admins.has(user.walletAddress)) return;
    await prisma.adminAction
      .create({
        data: {
          wallet: user.walletAddress,
          deviceId: user.deviceId ?? null,
          method: request.method,
          route,
          // A read's query carries the download's nonce and signature: only its params are kept.
          detail: actionDetail(read ? { params: request.params, body: undefined } : request) ?? Prisma.DbNull,
          statusCode: reply.statusCode,
        },
      })
      .catch((err: unknown) => request.log.warn({ err }, "admin action not recorded"));
  });
}
