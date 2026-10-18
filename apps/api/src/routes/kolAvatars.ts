import type { FastifyInstance } from "fastify";
import { avatarHandle, prisma } from "@trenchscanner/core";

/**
 * GET /kol-avatars/:handle: a KOL's X picture, as the worker stored it (KolAvatar, kolAvatars.ts),
 * so the dashboard never loads it from X itself (user ask 2026-10-18). Public, like the picture on
 * X: an <img> sends no session. The dashboard asks for it as /kol-avatars/<handle>?v=<hash>
 * (kolRoster.ts), so a browser may keep it for good; a new picture is a new URL.
 */
export async function registerKolAvatarRoutes(app: FastifyInstance) {
  app.get("/:handle", async (request, reply) => {
    const handle = avatarHandle((request.params as { handle?: string }).handle);
    const row = handle
      ? await prisma.kolAvatar.findUnique({
          where: { handle },
          select: { status: true, image: true, contentType: true },
        })
      : null;
    if (!row || row.status !== "ok" || !row.image || !row.contentType)
      return reply.code(404).header("Cache-Control", "public, max-age=3600").send({ error: "not_found" });
    // The dashboard is on another origin: helmet's same-origin default would block the <img>.
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type(row.contentType);
    return reply.send(Buffer.from(row.image));
  });
}
