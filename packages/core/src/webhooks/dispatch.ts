import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Prisma } from "@prisma/client";
import type { Env } from "../config/env.js";
import { namePassLock, prisma } from "../db.js";
import { createLogger } from "../logger.js";
import { loadFeedModelState, type FeedModelState } from "../curation/feedModels.js";
import { isFetchableUrl, isPublicAddress } from "../telegram/api.js";
import {
  COMMIT_GRACE_MS,
  MAX_ALERT_AGE_MS,
  MAX_COMMIT_WAIT_MS,
  oldestOpenTransaction,
} from "../telegram/dispatch.js";

/**
 * The scanner worker's webhook-dispatch job (2026-11-05, the first outside user of /stats): every
 * few seconds, queue each partner webhook (PartnerWebhook, set by the partner with its own token
 * at PUT /stats/webhook) the model calls it takes since its cursor, then POST what is due.
 *
 * - Which calls: the models the partner listed, else the default feed's (the top models, what a
 *   new subscriber's Live Feed shows). Read like the Telegram and web-push dispatchers (a cursor
 *   behind the commit horizon), so a restart picks up where it left off and nothing is sent twice:
 *   a delivery row per (webhook, alert) is the idempotency key.
 * - Signed: `X-TrenchScanner-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`,
 *   with a fresh timestamp at each attempt so a receiver can refuse replays (WEBHOOK_TOLERANCE_S).
 * - Retried on anything but a 2xx, at WEBHOOK_RETRY_DELAYS_MS, then marked failed; an alert older
 *   than MAX_ALERT_AGE_MS is not news and is failed rather than sent late. A 410 pauses the
 *   webhook ("gone"), as do WEBHOOK_MAX_FAILURES failed attempts in a row ("failing"); the partner
 *   turns it back on with a PUT.
 * - The URL is the partner's choice, so it is untrusted: https on 443 to a public address only,
 *   checked when saved and again at every send with the connection pinned to the address checked
 *   (a DNS answer that changes between the check and the connect can't aim it inward). Redirects
 *   are not followed and the answer's body is never read past a few hundred bytes.
 */

const logger = createLogger("webhook-dispatch");

/** Held for the length of a pass, so only one process is ever sending. */
export const WEBHOOK_DISPATCH_LOCK = "webhook-dispatch";
/** The wait before each retry; one attempt more than there are delays. */
export const WEBHOOK_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
/** Failed attempts in a row before a webhook is paused rather than retried forever. */
export const WEBHOOK_MAX_FAILURES = 50;
/** How old a signature a receiver should accept, in seconds (the README's verification example). */
export const WEBHOOK_TOLERANCE_S = 300;
/** Delivery rows are kept this long, for GET /stats/webhook/deliveries. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 14;
/** How long one POST may take, connect to last byte. */
const SEND_TIMEOUT_MS = 10_000;
/** Sends out at once, and per pass. */
const MAX_IN_FLIGHT = 8;
const MAX_DUE_PER_PASS = 200;
/** How long one pass may spend sending before it leaves the rest for the next one. */
const PASS_BUDGET_MS = 25_000;
const PASS_TRANSACTION_TIMEOUT_MS = 120_000;
const DAY_MS = 86_400_000;
const USER_AGENT = "TrenchScanner-Webhooks/1";

export const WEBHOOK_EVENTS = ["alert.created", "ping"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** A fresh signing secret: 32 random bytes, prefixed so a leaked one is recognisable. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

/** The signature header's value for a body sent at `timestampS`. */
export function signWebhook(secret: string, timestampS: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampS}.${body}`).digest("hex");
  return `t=${timestampS},v1=${mac}`;
}

/**
 * Whether a URL may be saved as a webhook, by its spelling alone: https, no credentials, port 443,
 * a dotted host name or a public IP literal, and not a local-only name. The send checks the
 * addresses it resolves to as well (isFetchableUrl, then the pinned connect).
 */
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (raw.length > 2048) return "longer than 2048 characters";
  if (url.protocol !== "https:") return "must be https";
  if (url.username || url.password) return "must not carry credentials";
  if (url.port !== "" && url.port !== "443") return "must use port 443";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) return isPublicAddress(host) ? null : "must be a public address";
  if (!host.includes(".") || /\.(localhost|local|internal|lan|home|corp)\.?$/.test(host)) {
    return "must be a public host name";
  }
  return null;
}

/** What a send got back: a status, or none (no connection, a timeout, a refused address). */
export interface WebhookSendResult {
  status: number | null;
  error: string | null;
}

export type WebhookSender = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<WebhookSendResult>;

/** A DNS lookup that answers only with public addresses: the connect is pinned to what was checked. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, "", 0);
    const allowed = addresses.filter((a) => isPublicAddress(a.address));
    if (allowed.length === 0 || allowed.length !== addresses.length) {
      const refused = Object.assign(new Error(`${hostname} resolves to a non-public address`), {
        code: "EADDRNOTPUBLIC",
      });
      return callback(refused, "", 0);
    }
    if ((options as { all?: boolean }).all)
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, allowed);
    return callback(null, allowed[0]!.address, allowed[0]!.family);
  });
};

/** The real sender: one POST, no redirects, the answer's body read only for the error message. */
export const httpsWebhookSender: WebhookSender = async (raw, headers, body) => {
  if (webhookUrlProblem(raw) !== null || !(await isFetchableUrl(new URL(raw)))) {
    return { status: null, error: "url refused (not https on 443 to a public address)" };
  }
  const url = new URL(raw);
  return new Promise<WebhookSendResult>((resolve) => {
    const req = httpsRequest(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
        lookup: publicLookup,
        timeout: SEND_TIMEOUT_MS,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (text.length < 300) text += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode ?? null;
          const ok = status !== null && status >= 200 && status < 300;
          resolve({ status, error: ok ? null : `HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ""}` });
        });
        res.on("error", (err) =>
          resolve({ status: res.statusCode ?? null, error: String(err).slice(0, 200) }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no answer in ${SEND_TIMEOUT_MS}ms`)));
    req.on("error", (err) => resolve({ status: null, error: String(err).slice(0, 200) }));
    req.end(body);
  });
};

/** The body every delivery POSTs: the event, the delivery's id and when, and the event's data. */
export function webhookBody(
  delivery: { id: string; event: string; payload: Prisma.JsonValue },
  sentAt: Date,
): string {
  return JSON.stringify({
    id: delivery.id,
    event: delivery.event,
    sentAt: sentAt.toISOString(),
    data: delivery.payload,
  });
}

const CALL_SELECT = {
  id: true,
  tokenId: true,
  createdAt: true,
  model: true,
  modelName: true,
  confidence: true,
  tier: true,
  calibratedPct: true,
  reasons: true,
  anchorPriceUsd: true,
  anchorMcapUsd: true,
  narrativeVerdict: true,
  token: { select: { mintAddress: true, symbol: true, name: true, imageUrl: true } },
} as const;

type CallRow = Prisma.CuratedAlertGetPayload<{ select: typeof CALL_SELECT }>;

/**
 * One call as a webhook carries it: what the Live Feed card shows of it. Token name, symbol and
 * image are the launcher's text - a receiver should treat them as untrusted.
 */
export function alertPayload(call: CallRow): Prisma.InputJsonObject {
  return {
    alertId: call.id,
    createdAt: call.createdAt.toISOString(),
    model: call.model,
    modelName: call.modelName,
    confidence: call.confidence,
    tier: call.tier,
    calibratedPct: call.calibratedPct,
    reasons: call.reasons,
    narrativeVerdict: call.narrativeVerdict,
    anchorPriceUsd: call.anchorPriceUsd,
    anchorMcapUsd: call.anchorMcapUsd,
    token: {
      mint: call.token.mintAddress,
      symbol: call.token.symbol,
      name: call.token.name,
      imageUrl: call.token.imageUrl,
    },
  };
}

export interface WebhookDeps {
  send?: WebhookSender;
  now?: () => number;
  feedModelState?: () => Promise<FeedModelState>;
  oldestOpenTransaction?: () => Promise<Date | null>;
}

export interface WebhookSummary {
  webhooks: number;
  queued: number;
  delivered: number;
  failed: number;
  retrying: number;
  paused: number;
  /** How far the pass read; unset when it read nothing. */
  horizon?: Date;
}

/** One pass. Returns what it did, for the heartbeat. */
export async function runWebhookDispatch(env: Env, deps: WebhookDeps = {}): Promise<WebhookSummary> {
  const summary: WebhookSummary = { webhooks: 0, queued: 0, delivered: 0, failed: 0, retrying: 0, paused: 0 };
  return prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${WEBHOOK_DISPATCH_LOCK})) AS locked`;
      if (!lock?.locked) return summary;
      await namePassLock(tx);
      await queuePass(env, deps, summary, tx);
      await sendPass(deps, summary);
      return summary;
    },
    { maxWait: 10_000, timeout: PASS_TRANSACTION_TIMEOUT_MS },
  );
}

/** Queues each enabled webhook the calls it takes since its cursor, and moves the cursor. */
async function queuePass(
  env: Env,
  deps: WebhookDeps,
  summary: WebhookSummary,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const hooks = await prisma.partnerWebhook.findMany({
    where: { enabled: true },
    select: { id: true, models: true, sentThrough: true },
  });
  summary.webhooks = hooks.length;
  if (hooks.length === 0) return;

  const startedAt = now();
  const openSince = await (deps.oldestOpenTransaction ?? (() => oldestOpenTransaction(tx)))();
  const horizon = new Date(
    Math.max(
      startedAt - MAX_COMMIT_WAIT_MS,
      Math.min(startedAt - COMMIT_GRACE_MS, openSince ? openSince.getTime() - 1 : Infinity),
    ),
  );
  summary.horizon = horizon;
  const oldest = new Date(startedAt - MAX_ALERT_AGE_MS);
  for (const h of hooks) if (h.sentThrough < oldest) h.sentThrough = oldest;
  const since = new Date(Math.min(...hooks.map((h) => h.sentThrough.getTime())));

  const calls =
    since < horizon
      ? await prisma.curatedAlert.findMany({
          where: { createdAt: { gt: since, lte: horizon }, model: { not: null } },
          orderBy: { createdAt: "asc" },
          select: CALL_SELECT,
        })
      : [];
  const needsDefault = calls.length > 0 && hooks.some((h) => h.models.length === 0);
  const state = needsDefault ? await (deps.feedModelState ?? (() => loadFeedModelState(env)))() : null;

  for (const hook of hooks) {
    const models = new Set(hook.models.length > 0 ? hook.models : (state?.defaultModels ?? []));
    const theirs = calls.filter(
      (c) => c.createdAt > hook.sentThrough && c.model !== null && models.has(c.model),
    );
    if (theirs.length > 0) {
      const { count } = await prisma.partnerWebhookDelivery.createMany({
        data: theirs.map((c) => ({
          webhookId: hook.id,
          event: "alert.created",
          curatedAlertId: c.id,
          payload: alertPayload(c),
        })),
        skipDuplicates: true,
      });
      summary.queued += count;
    }
    // Never backwards: a PUT may have moved it past this pass's horizon meanwhile.
    await prisma.partnerWebhook.updateMany({
      where: { id: hook.id, sentThrough: { lt: horizon } },
      data: { sentThrough: horizon },
    });
  }
}

/** Sends what is due, a few at a time inside the pass budget, and prunes old deliveries. */
async function sendPass(deps: WebhookDeps, summary: WebhookSummary): Promise<void> {
  const send = deps.send ?? httpsWebhookSender;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const due = await prisma.partnerWebhookDelivery.findMany({
    where: { status: "pending", nextAttemptAt: { lte: new Date(startedAt) }, webhook: { enabled: true } },
    orderBy: { nextAttemptAt: "asc" },
    take: MAX_DUE_PER_PASS,
    select: {
      id: true,
      event: true,
      payload: true,
      attempts: true,
      createdAt: true,
      webhook: { select: { id: true, url: true, secret: true } },
    },
  });
  // One webhook's sends go out in order, one at a time; different webhooks' side by side.
  const byHook = new Map<string, typeof due>();
  for (const d of due) {
    const list = byHook.get(d.webhook.id);
    if (list) list.push(d);
    else byHook.set(d.webhook.id, [d]);
  }
  const queues = [...byHook.values()];
  const paused = new Set<string>();
  const worker = async () => {
    for (;;) {
      const queue = queues.shift();
      if (!queue) return;
      for (const d of queue) {
        if (now() - startedAt > PASS_BUDGET_MS || paused.has(d.webhook.id)) break;
        await attempt(d, send, now, summary, paused);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, queues.length) }, worker));

  await prisma.partnerWebhookDelivery.deleteMany({
    where: { createdAt: { lt: new Date(startedAt - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS) } },
  });
}

type DueRow = {
  id: string;
  event: string;
  payload: Prisma.JsonValue;
  attempts: number;
  createdAt: Date;
  webhook: { id: string; url: string; secret: string };
};

async function attempt(
  d: DueRow,
  send: WebhookSender,
  now: () => number,
  summary: WebhookSummary,
  paused: Set<string>,
): Promise<void> {
  const at = now();
  // An alert is for trading on: past the news window it is failed, not delivered late.
  if (d.event === "alert.created" && at - d.createdAt.getTime() > MAX_ALERT_AGE_MS) {
    summary.failed += 1;
    await prisma.partnerWebhookDelivery.update({
      where: { id: d.id },
      data: { status: "failed", lastError: "expired: older than the alert window" },
    });
    return;
  }
  const sentAt = new Date(at);
  const body = webhookBody(d, sentAt);
  const headers = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-trenchscanner-event": d.event,
    "x-trenchscanner-delivery": d.id,
    "x-trenchscanner-signature": signWebhook(d.webhook.secret, Math.floor(at / 1000), body),
  };
  let result: WebhookSendResult;
  try {
    result = await send(d.webhook.url, headers, body);
  } catch (err) {
    result = { status: null, error: String(err).slice(0, 200) };
  }
  const attempts = d.attempts + 1;
  const ok = result.status !== null && result.status >= 200 && result.status < 300;
  if (ok) {
    summary.delivered += 1;
    await prisma.$transaction([
      prisma.partnerWebhookDelivery.update({
        where: { id: d.id },
        data: {
          status: "delivered",
          attempts,
          lastStatus: result.status,
          lastError: null,
          deliveredAt: sentAt,
        },
      }),
      prisma.partnerWebhook.update({
        where: { id: d.webhook.id },
        data: { consecutiveFailures: 0, lastDeliveryAt: sentAt },
      }),
    ]);
    return;
  }
  const outOfAttempts = attempts >= WEBHOOK_MAX_ATTEMPTS;
  if (outOfAttempts) summary.failed += 1;
  else summary.retrying += 1;
  await prisma.partnerWebhookDelivery.update({
    where: { id: d.id },
    data: {
      status: outOfAttempts ? "failed" : "pending",
      attempts,
      lastStatus: result.status,
      lastError: result.error,
      nextAttemptAt: new Date(at + (WEBHOOK_RETRY_DELAYS_MS[attempts - 1] ?? 0)),
    },
  });
  const hook = await prisma.partnerWebhook.update({
    where: { id: d.webhook.id },
    data: { consecutiveFailures: { increment: 1 } },
    select: { consecutiveFailures: true },
  });
  const reason =
    result.status === 410 ? "gone" : hook.consecutiveFailures >= WEBHOOK_MAX_FAILURES ? "failing" : null;
  if (reason) {
    paused.add(d.webhook.id);
    summary.paused += 1;
    await prisma.partnerWebhook.update({
      where: { id: d.webhook.id },
      data: { enabled: false, pausedReason: reason },
    });
    // Not the error text: the receiver's answer is its own words.
    logger.warn("partner webhook paused", { webhookId: d.webhook.id, reason, lastStatus: result.status });
  }
}
