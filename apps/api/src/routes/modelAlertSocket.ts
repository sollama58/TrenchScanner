import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import { adminWalletSet, prisma, resolveAccess, type Env } from "@trenchscanner/core";
import { ipRateLimitKey } from "../clientIp.js";
import type { ModelAlertClient, ModelAlertHub } from "../modelAlertHub.js";
import {
  hashModelAlertKey,
  isModelAlertKeyShape,
  modelAlertKeyAccess,
  modelAlertKeyDeniedMessage,
  modelAlertKeyMatches,
} from "../modelAlertKey.js";

/**
 * Failed authentications remembered on this process, per source address (ipRateLimitKey).
 *
 * Past the cap, an address's wrong or malformed keys are refused as too many attempts. A key
 * whose hash matches a live row still connects: the cap is never a lockout for a real key.
 * It used to be one window across every address, and then one caller sending 30 bad headers a
 * minute refused every customer's reconnect (audit 2026-10-22, AT-2). Guessing is not what it
 * guards against: a key is 32 random bytes. The route's per-IP rate limit bounds the reads.
 */
const AUTH_FAILURE_WINDOW_MS = 60_000;
export const MODEL_ALERT_AUTH_FAILURES_PER_MINUTE = 30;
/** Addresses remembered. Past it the one whose window opened first is dropped. */
const MAX_FAILURE_ADDRESSES = 10_000;
const authFailures = new Map<string, number[]>();

/**
 * Sockets waiting for a first-frame key. They are not in the hub and must not accumulate. Each
 * address holds only a few of them, and one that sends nothing by the deadline counts as a failed
 * attempt: a handful of keyless connects from a few addresses used to keep the whole pool of 32
 * full, and every browser-style client was closed with 4429 (audit 2026-10-23, AS-3). A pending
 * socket costs one timer, so the pool itself can be larger.
 */
const MAX_PENDING_AUTHS = 256;
const MAX_PENDING_AUTHS_PER_ADDRESS = 4;
const AUTH_DEADLINE_MS = 5_000;
let pendingAuths = 0;
const pendingByAddress = new Map<string, number>();

/** Stand-in HMAC so a missing row still pays for a constant-time compare. */
const DUMMY_HASH = "0".repeat(64);

/**
 * Model Alert websocket.
 *
 * The key is not read from the query string. This process does not write an access log
 * (disableRequestLogging) and its error logs keep the route pattern, but the request target
 * is what an edge access log stores, and the websocket plugin logs that target for an upgrade
 * that hits no websocket route. A secret in the query would be copied into those logs.
 *
 * Clients authenticate in one of these ways:
 *   - `Authorization: Bearer <key>` on the upgrade, or
 *   - `X-Api-Key: <key>` on the upgrade, or
 *   - the first text frame after connecting: the key alone, or JSON `{"key":"<key>"}`.
 * The frame has a few seconds to arrive. One attempt. Later frames are ignored and are not
 * copied into alerts. The key is never written to a log.
 *
 * A missing, unknown, or revoked key is rejected. A key whose user no longer has admin,
 * whitelist, or paid subscription access is rejected. Later, a revoked key or a lapsed
 * subscription closes the open socket. Messages are curated alerts that arrive after
 * authentication. There is no backlog, and filter matches are not sent.
 */
export async function registerModelAlertSocket(app: FastifyInstance, opts: { env: Env; hub: ModelAlertHub }) {
  const admins = adminWalletSet(opts.env);

  app.get(
    "/v1/model-alerts",
    {
      websocket: true,
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute", keyGenerator: ipRateLimitKey },
      },
      preHandler: async (request, reply) => {
        const presented = keyFromHeaders(request.headers);
        if (presented.kind === "absent") {
          request.modelAlertPending = true;
          return;
        }
        const address = ipRateLimitKey(request);
        if (presented.kind === "malformed") {
          if (tooManyAuthFailures(address)) return reply.code(429).send({ error: "too_many_attempts" });
          recordAuthFailure(address);
          return reply.code(401).send({ error: "invalid_api_key" });
        }
        const result = await authenticateKey(presented.key, admins, opts.env.JWT_SECRET);
        if (!result.ok) {
          if (result.status === 401) {
            if (tooManyAuthFailures(address)) return reply.code(429).send({ error: "too_many_attempts" });
            recordAuthFailure(address);
          }
          return reply.code(result.status).send({ error: result.error });
        }
        request.modelAlertClient = { ...result.client, openedAt: Date.now() };
      },
    },
    (socket, request) => {
      const client = request.modelAlertClient;
      if (client) {
        admit(opts.hub, socket, client);
        ignoreClientFrames(socket);
        return;
      }
      // preHandler refused and answered. Do not keep a socket the upgrade should not have.
      if (!request.modelAlertPending) {
        socket.close(4401, "unauthorized");
        return;
      }
      const address = ipRateLimitKey(request);
      const mine = pendingByAddress.get(address) ?? 0;
      if (pendingAuths >= MAX_PENDING_AUTHS || mine >= MAX_PENDING_AUTHS_PER_ADDRESS) {
        socket.close(4429, "too_many_sockets");
        return;
      }
      pendingAuths += 1;
      pendingByAddress.set(address, mine + 1);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        pendingAuths -= 1;
        const left = (pendingByAddress.get(address) ?? 1) - 1;
        if (left > 0) pendingByAddress.set(address, left);
        else pendingByAddress.delete(address);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        finish();
        // No key by the deadline: a failed attempt for this address, like a wrong one.
        recordAuthFailure(address);
        try {
          socket.close(4401, "unauthorized");
        } catch {
          // Already closed.
        }
      }, AUTH_DEADLINE_MS);
      timer.unref?.();
      socket.once("close", finish);
      let framed = false;
      socket.on("message", (data) => {
        // Authenticated or not, a client frame is never written back out.
        if (settled || framed) return;
        framed = true;
        // The deadline keeps running through the key check. A check that hangs on the database
        // still closes the socket, and a late answer finds it closed and admits nothing.
        void authenticateFrame(opts, admins, socket, data, address).finally(finish);
      });
    },
  );
}

function admit(hub: ModelAlertHub, socket: WebSocket, client: ModelAlertClient): void {
  if (socket.readyState !== 1) return;
  const admitted = hub.connect(socket, client);
  if (admitted !== "ok") socket.close(4429, "too_many_sockets");
}

/** After the first frame, further frames are discarded. They are not alerts and not echoed. */
function ignoreClientFrames(socket: WebSocket): void {
  socket.on("message", () => {});
}

async function authenticateFrame(
  opts: { env: Env; hub: ModelAlertHub },
  admins: ReadonlySet<string>,
  socket: WebSocket,
  data: RawData,
  address: string,
): Promise<void> {
  const secret = keyFromFrame(data);
  if (!secret) {
    refuseGuess(socket, address);
    return;
  }
  try {
    const result = await authenticateKey(secret, admins, opts.env.JWT_SECRET);
    if (!result.ok) {
      if (result.status === 401) {
        refuseGuess(socket, address);
        return;
      }
      socket.close(
        result.status === 403 ? 4403 : 4401,
        result.status === 403 ? "access_ended" : "unauthorized",
      );
      return;
    }
    admit(opts.hub, socket, { ...result.client, openedAt: Date.now() });
    ignoreClientFrames(socket);
  } catch {
    // The key could not be checked (database error). Close so the client reconnects, instead
    // of leaving it on a socket that is neither admitted nor timed. Not counted as a failure.
    try {
      socket.close(1011, "try_again");
    } catch {
      // Already closed.
    }
  }
}

async function authenticateKey(
  secret: string,
  admins: ReadonlySet<string>,
  serverSecret: string,
): Promise<
  { ok: true; client: Omit<ModelAlertClient, "openedAt"> } | { ok: false; status: 401 | 403; error: string }
> {
  if (!isModelAlertKeyShape(secret)) return { ok: false, status: 401, error: "invalid_api_key" };
  const row = await prisma.userApiKey.findUnique({
    where: { secretHash: hashModelAlertKey(secret, serverSecret) },
    select: {
      id: true,
      revokedAt: true,
      secretHash: true,
      user: { select: { id: true, walletAddress: true } },
    },
  });
  const matches = modelAlertKeyMatches(secret, row?.secretHash ?? DUMMY_HASH, serverSecret);
  // Unknown and revoked are the same answer, so a revoked key does not connect.
  if (!row || !matches || row.revokedAt) return { ok: false, status: 401, error: "invalid_api_key" };

  const access = await resolveAccess(row.user.walletAddress, admins);
  if (!modelAlertKeyAccess(access)) {
    return { ok: false, status: 403, error: modelAlertKeyDeniedMessage(access.reason) };
  }
  return { ok: true, client: { userId: row.user.id, keyId: row.id, walletAddress: row.user.walletAddress } };
}

/** Header key, or absent when the client will send the first frame. The query string is not read. */
function keyFromHeaders(
  headers: FastifyRequest["headers"],
): { kind: "key"; key: string } | { kind: "malformed" } | { kind: "absent" } {
  const authorization = headers.authorization;
  if (typeof authorization === "string" && authorization.trim() !== "") {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (!match?.[1] || !isModelAlertKeyShape(match[1])) return { kind: "malformed" };
    return { kind: "key", key: match[1] };
  }
  const header = headers["x-api-key"];
  if (Array.isArray(header)) return { kind: "malformed" };
  if (typeof header === "string" && header.trim() !== "") {
    const key = header.trim();
    if (!isModelAlertKeyShape(key)) return { kind: "malformed" };
    return { kind: "key", key };
  }
  return { kind: "absent" };
}

/** The first frame: the key itself, or a JSON object whose only read field is `key`. */
function keyFromFrame(data: RawData): string | null {
  const text = frameText(data);
  if (text === null || text.length > 512) return null;
  const trimmed = text.trim();
  if (isModelAlertKeyShape(trimmed)) return trimmed;
  if (!trimmed.startsWith("{")) return null;
  try {
    const body = JSON.parse(trimmed) as { key?: unknown };
    if (typeof body.key !== "string") return null;
    const key = body.key.trim();
    return isModelAlertKeyShape(key) ? key : null;
  } catch {
    return null;
  }
}

function frameText(data: RawData): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/** A wrong or malformed first-frame key: counted, and refused as too many past the address's cap. */
function refuseGuess(socket: WebSocket, address: string): void {
  if (tooManyAuthFailures(address)) {
    socket.close(4429, "too_many_attempts");
    return;
  }
  recordAuthFailure(address);
  socket.close(4401, "unauthorized");
}

function tooManyAuthFailures(address: string, now = Date.now()): boolean {
  const times = authFailures.get(address);
  if (!times) return false;
  const cutoff = now - AUTH_FAILURE_WINDOW_MS;
  while (times.length > 0 && times[0]! <= cutoff) times.shift();
  if (times.length === 0) authFailures.delete(address);
  return times.length >= MODEL_ALERT_AUTH_FAILURES_PER_MINUTE;
}

function recordAuthFailure(address: string, now = Date.now()): void {
  const times = authFailures.get(address);
  if (times) {
    // Only the cap's worth is needed to answer tooManyAuthFailures.
    times.push(now);
    if (times.length > MODEL_ALERT_AUTH_FAILURES_PER_MINUTE) times.shift();
    return;
  }
  if (authFailures.size >= MAX_FAILURE_ADDRESSES) authFailures.delete(authFailures.keys().next().value!);
  authFailures.set(address, [now]);
}
