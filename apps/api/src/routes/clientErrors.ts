import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createLogger } from "@trenchscanner/core";
import { chartHealth } from "../chartHealth.js";
import { clean } from "./feedback.js";

const logger = createLogger("client-errors");

/**
 * POST /client-errors: the web's error boundaries and chunk failures, reported (user ask
 * 2026-10-19, after the charts robustness audit: a broken chart only ever reached
 * console.error, so we learned of it from users). Logged with logger.warn and counted in
 * chartHealth by `where`; nothing is stored.
 *
 * Open to everyone (a crash can come before sign-in), so it is held back by the route's own rate
 * limit (keyed like every route: the signed-in device, else the IP) and a small body limit, and
 * every field is cut to its length rather than refused: a report is never worth a retry loop.
 */

export const CLIENT_ERROR_LIMITS = { where: 80, message: 500, stack: 2000, version: 40, path: 200 } as const;
/** A crash loop on one page sends a few; more than this a minute from one caller is noise. */
const RATE_LIMIT = { max: 20, timeWindow: "1 minute" };
/** The fields at their caps fit in well under this. */
const BODY_LIMIT = 8 * 1024;

const field = (max: number) =>
  z
    .string()
    .transform((v) => clean(v).slice(0, max))
    .optional();

const bodySchema = z.object({
  where: z
    .string()
    .transform((v) => clean(v).slice(0, CLIENT_ERROR_LIMITS.where))
    .pipe(z.string().min(1)),
  message: z.string().transform((v) => clean(v).slice(0, CLIENT_ERROR_LIMITS.message)),
  stack: field(CLIENT_ERROR_LIMITS.stack),
  version: field(CLIENT_ERROR_LIMITS.version),
  path: field(CLIENT_ERROR_LIMITS.path),
});

export type ClientErrorReport = z.infer<typeof bodySchema>;

export async function registerClientErrorRoutes(app: FastifyInstance) {
  app.post("/", { config: { rateLimit: RATE_LIMIT }, bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const report = parsed.data;
    chartHealth().recordClientError(report.where);
    logger.warn("client error", {
      where: report.where,
      message: report.message,
      stack: report.stack,
      version: report.version,
      path: report.path,
    });
    return reply.code(204).send();
  });
}
