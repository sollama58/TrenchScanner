import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createLogger } from "@trenchscanner/core";
import { ipRateLimitKey } from "../clientIp.js";
import {
  LruCache,
  XPreviewMissing,
  fetchXPicture,
  fetchXPreview,
  parseXLink,
  xLinkFromKey,
  xLinkKey,
  type ResolvedXPreview,
  type XLink,
  type XPicture,
  type XPictureSlot,
} from "../xPreview.js";

const logger = createLogger("x-preview");

/** An account's numbers move slowly, and a hover only needs them roughly right. */
const PREVIEW_TTL_MS = 30 * 60_000;
/** "No such account or post" is settled for a while; an outage is retried soon. */
const MISSING_TTL_MS = 30 * 60_000;
const FAILED_TTL_MS = 60_000;
const PICTURE_TTL_MS = 6 * 60 * 60_000;

/** Hovers are cheap to make by the dozen while a reader scans the feed; this is generous for that. */
const PREVIEW_RATE_LIMIT = { max: 120, timeWindow: "1 minute", keyGenerator: ipRateLimitKey };
const PICTURE_RATE_LIMIT = { max: 240, timeWindow: "1 minute", keyGenerator: ipRateLimitKey };

const previewQuery = z.object({ url: z.string().min(1).max(500) });
const pictureParams = z.object({
  key: z.string().min(3).max(40),
  slot: z.enum(["avatar", "banner", "media"]),
});

type Outcome = { ok: true; value: ResolvedXPreview } | { ok: false; missing: boolean };

export interface XPreviewRouteOptions {
  fetchImpl?: typeof fetch;
}

/**
 * GET /x-preview?url=<a coin's X link>: what the dashboard shows on hovering that link (user ask
 * 2026-10-18), and GET /x-preview/image/:key/:slot for its pictures. Open to guests, who see the
 * same cards: everything here is public on X anyway. The image route only serves pictures a
 * preview named, so it can't be used to fetch anything else through this server.
 */
export async function registerXPreviewRoutes(app: FastifyInstance, opts: XPreviewRouteOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const previews = new LruCache<Outcome>(5_000);
  const pictures = new LruCache<XPicture | null>(2_000, 64 * 1024 * 1024, (p) => p?.bytes.length ?? 0);
  const previewFills = new Map<string, Promise<Outcome>>();
  const pictureFills = new Map<string, Promise<XPicture | null>>();

  /** Single-flight: a card grid shows the same coin's link many times over. */
  function resolve(link: XLink): Promise<Outcome> {
    const key = xLinkKey(link);
    const cached = previews.get(key);
    if (cached) return Promise.resolve(cached);
    let fill = previewFills.get(key);
    if (!fill) {
      fill = fetchXPreview(link, fetchImpl)
        .then((value): Outcome => {
          previews.set(key, { ok: true, value }, PREVIEW_TTL_MS);
          return { ok: true, value };
        })
        .catch((err: unknown): Outcome => {
          const missing = err instanceof XPreviewMissing;
          if (!missing) logger.warn("x preview read failed", { key, error: String(err) });
          const outcome: Outcome = { ok: false, missing };
          previews.set(key, outcome, missing ? MISSING_TTL_MS : FAILED_TTL_MS);
          return outcome;
        })
        .finally(() => previewFills.delete(key));
      previewFills.set(key, fill);
    }
    return fill;
  }

  function picture(url: string): Promise<XPicture | null> {
    const cached = pictures.get(url);
    if (cached !== undefined) return Promise.resolve(cached);
    let fill = pictureFills.get(url);
    if (!fill) {
      fill = fetchXPicture(url, fetchImpl)
        .then((p) => {
          pictures.set(url, p, PICTURE_TTL_MS);
          return p;
        })
        .catch((err: unknown) => {
          logger.warn("x picture read failed", { error: String(err) });
          // Held as briefly as a failed preview (misc audit 2026-10-23, A6): every card showing
          // the picture asked pbs.twimg.com again while it was failing. The 404 sent meanwhile
          // is the one a failure answers anyway.
          pictures.set(url, null, FAILED_TTL_MS);
          return null;
        })
        .finally(() => pictureFills.delete(url));
      pictureFills.set(url, fill);
    }
    return fill;
  }

  app.get("/", { config: { rateLimit: PREVIEW_RATE_LIMIT } }, async (request, reply) => {
    const parsed = previewQuery.safeParse(request.query);
    const link = parsed.success ? parseXLink(parsed.data.url) : null;
    if (!link) return reply.code(400).send({ error: "not_an_x_link" });
    const outcome = await resolve(link);
    if (!outcome.ok) {
      return outcome.missing
        ? reply.code(404).header("Cache-Control", "public, max-age=1800").send({ error: "not_found" })
        : reply.code(502).header("Cache-Control", "no-store").send({ error: "x_unavailable" });
    }
    reply.header("Cache-Control", "public, max-age=900");
    return outcome.value.preview;
  });

  app.get("/image/:key/:slot", { config: { rateLimit: PICTURE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = pictureParams.safeParse(request.params);
    const link = parsed.success ? xLinkFromKey(parsed.data.key) : null;
    if (!parsed.success || !link) return reply.code(404).send({ error: "not_found" });
    const outcome = await resolve(link);
    const url = outcome.ok ? outcome.value.pictures[parsed.data.slot as XPictureSlot] : undefined;
    const image = url ? await picture(url) : null;
    if (!image)
      return reply.code(404).header("Cache-Control", "public, max-age=600").send({ error: "not_found" });
    // The dashboard is on another origin: helmet's same-origin default would block the <img>.
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Cache-Control", "public, max-age=21600");
    reply.type(image.contentType);
    return reply.send(image.bytes);
  });
}
