import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@trenchscanner/core";

const filterInputSchema = z.object({
  name: z.string().min(1).max(60).default("Default"),
  mcapMin: z.number().nonnegative().default(50_000),
  mcapMax: z.number().positive().default(500_000),
  minVolumeMcapRatio: z.number().nonnegative().nullable().optional(),
  minHolderGrowthPct: z.number().nullable().optional(),
  maxTop10HolderPct: z.number().min(0).max(100).nullable().optional(),
  minTokenAgeMinutes: z.number().int().nonnegative().nullable().optional(),
  maxTokenAgeMinutes: z.number().int().nonnegative().nullable().optional(),
  narrativeKeywords: z.array(z.string()).default([]),
  minScore: z.number().min(0).max(100).nullable().optional(),
  isActive: z.boolean().default(true),
});

const filterUpdateSchema = filterInputSchema.partial();

export async function registerFilterRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

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
    if (parsed.data.mcapMin >= parsed.data.mcapMax) {
      return reply.code(400).send({ error: "mcapMin must be less than mcapMax" });
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
    if (merged.mcapMin >= merged.mcapMax) {
      return reply.code(400).send({ error: "mcapMin must be less than mcapMax" });
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
