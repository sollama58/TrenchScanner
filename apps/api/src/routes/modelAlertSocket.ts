import type { FastifyInstance } from "fastify";
import { adminWalletSet, prisma, resolveAccess, type Env } from "@trenchscanner/core";
import type { ModelAlertHub } from "../modelAlertHub.js";
import { hashModelAlertKey, modelAlertKeyAccess, modelAlertKeyDeniedMessage } from "../modelAlertKey.js";

/**
 * Model Alert websocket.
 *
 * Authenticate with the API key in the `key` query parameter:
 *   ws(s)://<api-host>/v1/model-alerts?key=tsma_...
 * The secret is not written to logs. A missing, unknown, or revoked key is rejected with 401
 * before the socket is used. A key whose user no longer has admin, whitelist, or paid
 * subscription access is rejected with 403. Later, a lapsed subscription closes the open socket
 * on the next alert or the hub's periodic check.
 *
 * Messages are curated alerts that arrive after this connection. There is no backlog, and filter
 * matches are not sent.
 */
export async function registerModelAlertSocket(app: FastifyInstance, opts: { env: Env; hub: ModelAlertHub }) {
  const admins = adminWalletSet(opts.env);

  app.get(
    "/v1/model-alerts",
    {
      websocket: true,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      preHandler: async (request, reply) => {
        const secret = keyFromQuery(request.query);
        if (!secret) return reply.code(401).send({ error: "api_key_required" });

        const row = await prisma.userApiKey.findUnique({
          where: { secretHash: hashModelAlertKey(secret) },
          select: {
            revokedAt: true,
            user: { select: { id: true, walletAddress: true } },
          },
        });
        // Unknown and revoked are the same answer, so a revoked key does not connect.
        if (!row || row.revokedAt) return reply.code(401).send({ error: "invalid_api_key" });

        const access = await resolveAccess(row.user.walletAddress, admins);
        if (!modelAlertKeyAccess(access)) {
          return reply.code(403).send({ error: modelAlertKeyDeniedMessage(access.reason) });
        }
        request.modelAlertClient = {
          userId: row.user.id,
          walletAddress: row.user.walletAddress,
          openedAt: Date.now(),
        };
      },
    },
    (socket, request) => {
      const client = request.modelAlertClient;
      // preHandler already refused. If the upgrade still reached here, do not keep the socket.
      if (!client) {
        socket.close(4401, "unauthorized");
        return;
      }
      opts.hub.connect(socket, client);
    },
  );
}

/** The `key` query parameter, or null when it is missing or not a key-shaped string. */
function keyFromQuery(query: unknown): string | null {
  if (typeof query !== "object" || query === null) return null;
  const raw = (query as { key?: unknown }).key;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const secret = value.trim();
  // tsma_ plus 32 bytes of base64url. Anything longer is not a key we issued.
  if (secret.length < 16 || secret.length > 200) return null;
  return secret;
}
