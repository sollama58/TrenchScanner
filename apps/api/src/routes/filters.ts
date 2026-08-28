import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Env, prisma, scanBand } from "@trenchscanner/core";

// A factory (rather than a module-level constant) so mcapMin/mcapMax default to this deployment's
// own MCAP_FILTER_MIN/MAX instead of a hardcoded literal that could drift out of sync with them -
// only matters for a POST that omits mcapMin/mcapMax entirely, but there's no reason to duplicate
// the number when env already has it.
function buildFilterInputSchema(env: Env) {
  return z.object({
    name: z.string().min(1).max(60).default("Default"),
    mcapMin: z.number().nonnegative().default(env.MCAP_FILTER_MIN),
    mcapMax: z.number().positive().default(env.MCAP_FILTER_MAX),
    minVolumeMcapRatio: z.number().nonnegative().nullable().optional(),
    minHolderGrowthPct: z.number().nullable().optional(),
    maxTop10HolderPct: z.number().min(0).max(100).nullable().optional(),
    maxDevWalletPct: z.number().min(0).max(100).nullable().optional(),
    maxRiskScore: z.number().min(0).max(100).nullable().optional(),
    excludeCriticalRiskFlags: z.boolean().default(false),
    // Not .int(): a fraction of a minute is how you express seconds here, and rejecting 0.25
    // would make the field's own placeholder a lie.
    minTokenAgeMinutes: z.number().nonnegative().nullable().optional(),
    maxTokenAgeMinutes: z.number().nonnegative().nullable().optional(),
    narrativeKeywords: z.array(z.string()).default([]),
    minScore: z.number().min(0).max(100).nullable().optional(),
    maxFreshTop10WalletPct: z.number().min(0).max(100).nullable().optional(),
    maxEmptyTop10WalletPct: z.number().min(0).max(100).nullable().optional(),
    isActive: z.boolean().default(true),
  });
}

export async function registerFilterRoutes(app: FastifyInstance, opts: { env: Env }) {
  // Filters are the product: they decide what the paid feed shows. Behind the paywall - see authenticateSubscriber in server.ts.
  app.addHook("preHandler", app.authenticateSubscriber);

  const filterInputSchema = buildFilterInputSchema(opts.env);
  const filterUpdateSchema = filterInputSchema.partial();

  // The true range a token could ever be scanned/matched at - see scanBand()'s own doc comment.
  // A user's mcapMin/mcapMax outside this can never match anything regardless of what they set,
  // so both the create and update handlers below reject it rather than silently accepting a
  // filter that will never fire. Computed once at startup since env only changes via redeploy.
  const { min: scanMin, max: scanMax } = scanBand(opts.env.MCAP_FILTER_MIN, opts.env.MCAP_FILTER_MAX);

  function mcapRangeError(mcapMin: number, mcapMax: number): string | null {
    if (mcapMin >= mcapMax) return "mcapMin must be less than mcapMax";
    if (mcapMin < scanMin || mcapMax > scanMax) {
      return `Market cap range must be within $${scanMin.toLocaleString()}-$${scanMax.toLocaleString()} - the platform never scans tokens outside that range`;
    }
    return null;
  }

  app.get("/", async (request) => {
    return prisma.userFilter.findMany({
      where: { userId: request.user!.userId },
      orderBy: { createdAt: "asc" },
    });
  });

  app.post("/", async (request, reply) => {
    const parsed = filterInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const rangeError = mcapRangeError(parsed.data.mcapMin, parsed.data.mcapMax);
    if (rangeError) {
      return reply.code(400).send({ error: rangeError });
    }
    const filter = await prisma.userFilter.create({
      data: { ...parsed.data, userId: request.user!.userId },
    });
    return reply.code(201).send(filter);
  });

  app.patch("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = filterUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }

    const existing = await prisma.userFilter.findUnique({ where: { id } });
    if (!existing || existing.userId !== request.user!.userId) {
      return reply.code(404).send({ error: "filter not found" });
    }

    const merged = { ...existing, ...parsed.data };
    const rangeError = mcapRangeError(merged.mcapMin, merged.mcapMax);
    if (rangeError) {
      return reply.code(400).send({ error: rangeError });
    }

    const updated = await prisma.userFilter.update({ where: { id }, data: parsed.data });
    return updated;
  });

  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.userFilter.findUnique({ where: { id } });
    if (!existing || existing.userId !== request.user!.userId) {
      return reply.code(404).send({ error: "filter not found" });
    }
    await prisma.userFilter.delete({ where: { id } });
    return reply.code(204).send();
  });
}
