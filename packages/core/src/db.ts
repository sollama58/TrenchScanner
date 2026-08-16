import { PrismaClient } from "@prisma/client";

/**
 * Singleton Prisma client. In dev, tsx/nodemon-style reloads can otherwise
 * spawn a new client (and new connection pool) per reload; stashing it on
 * globalThis avoids exhausting Postgres connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient } from "@prisma/client";
export * from "@prisma/client";
