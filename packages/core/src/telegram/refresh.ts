import type { Prisma } from "@prisma/client";
import type { InlineKeyboard } from "./api.js";
import type { AlertNow } from "./boards.js";
import {
  CAPTION_MAX_CHARS,
  captionLength,
  formatAlert,
  type AlertCall,
  type AlertCard,
  type AlertLinks,
  type AlertParts,
  type AlertStyle,
} from "./format.js";

/**
 * The Refresh button under a single alert (user ask 2026-10-23): a press rewrites the card in
 * place with the freshest numbers the database holds - the market cap now against the alert's,
 * the peak since, holders and volume - at most once per REFRESH_COOLDOWN_MS per message. The
 * card's calls and filters are the ones it was sent with, kept on its TelegramAlertSent row, so a
 * refresh never changes what raised the alert, only how it stands now.
 */

/** "rf:<token id>:<send time in ms, base 36>", the send's key (TelegramAlertSent's id). */
export const REFRESH_CALLBACK_PREFIX = "rf:";
/** One press per message per this long, whoever presses. */
export const REFRESH_COOLDOWN_MS = 15_000;
/** Telegram's limit on a button's callback_data, in bytes. */
const CALLBACK_DATA_MAX_BYTES = 64;
const REFRESH_DATA = /^rf:([A-Za-z0-9_-]{1,40}):([0-9a-z]{1,11})$/;

export function refreshCallbackData(tokenId: string, sentAt: Date): string | null {
  const data = `${REFRESH_CALLBACK_PREFIX}${tokenId}:${sentAt.getTime().toString(36)}`;
  return REFRESH_DATA.test(data) && Buffer.byteLength(data) <= CALLBACK_DATA_MAX_BYTES ? data : null;
}

/** The send a press names, or null for anything that isn't a well-formed refresh press. */
export function parseRefreshCallback(data: string): { tokenId: string; sentAt: Date } | null {
  const m = REFRESH_DATA.exec(data);
  if (!m) return null;
  const ms = parseInt(m[2]!, 36);
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  const sentAt = new Date(ms);
  return Number.isNaN(sentAt.getTime()) ? null : { tokenId: m[1]!, sentAt };
}

/** The button under a single alert; null when its key doesn't fit Telegram's callback data. */
export function refreshKeyboard(tokenId: string, sentAt: Date): InlineKeyboard | null {
  const data = refreshCallbackData(tokenId, sentAt);
  return data ? { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: data }]] } : null;
}

/** Whole seconds until the message may be refreshed again, at least 1. */
export function refreshWaitSeconds(refreshedAt: Date, now: number): number {
  return Math.max(1, Math.ceil((refreshedAt.getTime() + REFRESH_COOLDOWN_MS - now) / 1_000));
}

/** What TelegramAlertSent.card keeps: the card less its token, which is read fresh on a press. */
export function storedCard(card: AlertCard): Prisma.InputJsonValue {
  return {
    v: 1,
    raisedAt: card.raisedAt.toISOString(),
    snapshot: card.snapshot
      ? {
          marketCapUsd: card.snapshot.marketCapUsd,
          holderCount: card.snapshot.holderCount,
          holderCountAt: card.snapshot.holderCountAt?.toISOString() ?? null,
          volume1hUsd: card.snapshot.volume1hUsd,
        }
      : null,
    filters: card.filters.map((f) => ({ name: f.name, score: f.score })),
    calls: card.calls.map((c) => ({
      modelName: c.modelName,
      confidence: c.confidence,
      tier: c.tier,
      calibratedPct: c.calibratedPct,
      reasons: c.reasons,
      narrativeVerdict: c.narrativeVerdict,
    })),
  };
}

const MAX_ITEMS = 20;
const MAX_TEXT = 300;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, MAX_TEXT) : null);
const date = (v: unknown): Date | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * A stored card back as an AlertCard around the token's row now, or null when it is missing or
 * not in the shape storedCard writes. Read defensively: it is a JSON column, and a card is only
 * worth rebuilding when every part of it is what the formatter expects.
 */
export function readStoredCard(json: unknown, token: AlertCard["token"]): AlertCard | null {
  if (!isObj(json) || json.v !== 1) return null;
  const raisedAt = date(json.raisedAt);
  if (!raisedAt || !Array.isArray(json.filters) || !Array.isArray(json.calls)) return null;
  let snapshot: AlertCard["snapshot"] = null;
  if (json.snapshot !== null && json.snapshot !== undefined) {
    if (!isObj(json.snapshot)) return null;
    const marketCapUsd = num(json.snapshot.marketCapUsd);
    if (marketCapUsd === null) return null;
    snapshot = {
      marketCapUsd,
      holderCount: num(json.snapshot.holderCount),
      holderCountAt: date(json.snapshot.holderCountAt),
      volume1hUsd: num(json.snapshot.volume1hUsd),
    };
  }
  const filters: AlertCard["filters"] = [];
  for (const f of json.filters.slice(0, MAX_ITEMS)) {
    const name = isObj(f) ? text(f.name) : null;
    const score = isObj(f) ? num(f.score) : null;
    if (name === null || score === null) return null;
    filters.push({ name, score });
  }
  const calls: AlertCall[] = [];
  for (const c of json.calls.slice(0, MAX_ITEMS)) {
    if (!isObj(c)) return null;
    const modelName = text(c.modelName);
    const confidence = num(c.confidence);
    if (modelName === null || confidence === null || !Array.isArray(c.reasons)) return null;
    calls.push({
      modelName,
      confidence,
      tier: text(c.tier),
      calibratedPct: num(c.calibratedPct),
      reasons: c.reasons.slice(0, MAX_ITEMS).flatMap((r) => {
        const t = text(r);
        return t === null ? [] : [t];
      }),
      narrativeVerdict: text(c.narrativeVerdict),
    });
  }
  if (filters.length === 0 && calls.length === 0) return null;
  return { token, snapshot, filters, calls, raisedAt };
}

/**
 * The refreshed card's HTML: the stored card around the fresh token, its holders and volume
 * replaced by the newest on record, with the market now and the peak beside the alert's. A photo's
 * caption has to stay within Telegram's cap, so a card that grew past it drops its reasons, then
 * goes compact.
 */
export function formatRefreshedAlert(
  card: AlertCard,
  fresh: AlertNow,
  links: AlertLinks,
  now: number,
  parts: AlertParts,
  style: AlertStyle,
  asCaption: boolean,
): string {
  const snapshot = card.snapshot
    ? {
        ...card.snapshot,
        ...(fresh.holderCount !== null
          ? { holderCount: fresh.holderCount, holderCountAt: fresh.holderCountAt }
          : {}),
        ...(fresh.volume1hUsd !== null ? { volume1hUsd: fresh.volume1hUsd } : {}),
      }
    : null;
  const refreshed: AlertCard = { ...card, token: fresh.token, snapshot };
  const live = {
    alertMcapUsd: fresh.alertMcapUsd,
    nowMcapUsd: fresh.nowMcapUsd,
    peakPct: fresh.peakPct,
    refreshedAt: new Date(now),
  };
  const render = (p: AlertParts, s: AlertStyle) => formatAlert(refreshed, links, now, p, s, live);
  let html = render(parts, style);
  if (!asCaption || captionLength(html) <= CAPTION_MAX_CHARS) return html;
  html = render({ ...parts, reasons: false }, style);
  if (captionLength(html) <= CAPTION_MAX_CHARS) return html;
  return render({ ...parts, reasons: false }, { ...style, layout: "compact" });
}
