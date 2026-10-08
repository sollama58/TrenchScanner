import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { createLogger } from "../logger.js";
import { CAPTION_MAX_CHARS, captionLength } from "./format.js";

/**
 * The slice of Telegram's Bot API this app uses, over plain fetch. Deliberately not fetchJson:
 * that helper retries on 5xx and timeouts, which for sendMessage means a duplicate alert, and it
 * drops the body of a non-2xx answer, which is where Telegram says why ("bot was blocked by the
 * user", "retry after 7"). Every method here returns a typed result instead of throwing, so a
 * caller decides what a refusal means for the chat it was talking to.
 */

const logger = createLogger("telegram-api");

const API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;
/** Fetching a token's artwork: public IPFS gateways are slow, and an alert must not wait on one. */
const IMAGE_TIMEOUT_MS = 6_000;
/** Telegram takes photos up to 10 MB as an upload; anything bigger is not worth the bandwidth. */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Hops followed when fetching artwork; each one is checked like the first URL. */
const IMAGE_MAX_REDIRECTS = 3;

/** A host name's addresses, as the fetch would connect to them. Injectable for tests. */
export type HostResolver = (hostname: string) => Promise<string[]>;

const dnsResolve: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Addresses the worker must never fetch on a stranger's say-so: loopback, private and link-local
 * ranges (cloud metadata lives at 169.254.169.254), carrier NAT, multicast and reserved space.
 */
const NON_PUBLIC_V4 = new BlockList();
const NON_PUBLIC_V6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  NON_PUBLIC_V4.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  NON_PUBLIC_V6.addSubnet(net, prefix, "ipv6");

/**
 * True for an address on the public internet. Two lists, because a BlockList also matches IPv4
 * addresses against IPv4-mapped IPv6 rules; mapped addresses (::ffff:a.b.c.d) are refused whole.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.check(address, "ipv4");
  if (family === 6) return !NON_PUBLIC_V6.check(address, "ipv6");
  return false;
}

/**
 * Whether a URL is safe for the worker to fetch: https on the default port, no credentials, and
 * a host whose every address is public. Token artwork URLs are chosen by whoever launched the
 * coin, so without this an alert could make the worker read its own network (a DNS answer that
 * changes between this check and the connect could still slip through; the image-only, capped
 * answer and the upload to the linked chat bound what that would reveal).
 */
export async function isFetchableUrl(url: URL, resolve: HostResolver = dnsResolve): Promise<boolean> {
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) return isPublicAddress(host);
  if (!host.includes(".") || /\.(localhost|local|internal)\.?$/.test(host)) return false;
  try {
    const addresses = await resolve(host);
    return addresses.length > 0 && addresses.every(isPublicAddress);
  } catch {
    return false;
  }
}

/** Reads a body up to `max` bytes; null (and the rest abandoned) once it runs past. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** A picture fetched by us, to upload to Telegram as multipart rather than handed over as a URL. */
export interface FetchedImage {
  bytes: Uint8Array;
  contentType: string;
  sourceUrl: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChatInfo {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  /** Who posted, when it was a chat: the group itself for an admin posting anonymously. */
  sender_chat?: TelegramChatInfo;
  chat: TelegramChatInfo;
  date: number;
  text?: string;
  entities?: { type: string; offset: number; length: number }[];
}

export interface TelegramChatMemberUpdated {
  chat: TelegramChatInfo;
  from: TelegramUser;
  date: number;
  new_chat_member: { status: string; user: TelegramUser };
}

/** An incoming update, as Telegram POSTs it to the webhook. Only the kinds this app asked for. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  my_chat_member?: TelegramChatMemberUpdated;
}

export type TelegramResult<T> =
  | { ok: true; result: T }
  | {
      ok: false;
      /** Telegram's error_code, or 0 when the request never got an answer. */
      code: number;
      description: string;
      /** From a 429: how long Telegram wants us to wait, in seconds. */
      retryAfter?: number;
      /** From a 400 on a group that became a supergroup: its new chat id. */
      migrateToChatId?: number;
    };

/** The bot's token: non-empty means Telegram is configured. */
export function telegramConfigured(token: string): boolean {
  return token.trim().length > 0;
}

/**
 * The secret Telegram sends back in X-Telegram-Bot-Api-Secret-Token on every webhook call, so
 * nobody else can POST updates at the route. Derived from the token rather than a second env var:
 * anyone holding the token already owns the bot, so this is exactly as secret as it needs to be
 * and one less thing to set. Hex, which is inside Telegram's [A-Za-z0-9_-] alphabet.
 */
export function webhookSecret(token: string): string {
  return createHash("sha256").update(`trenchscanner-telegram-webhook:${token}`).digest("hex");
}

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly resolveHost: HostResolver = dnsResolve,
  ) {}

  /** One Bot API call. Never throws: a network failure is `{ ok: false, code: 0 }`. */
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<TelegramResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      // A Blob among the params (an uploaded photo) makes the request multipart; otherwise JSON.
      const upload = Object.values(params).some((v) => v instanceof Blob);
      let payload: string | FormData;
      const headers: Record<string, string> = {};
      if (upload) {
        const form = new FormData();
        for (const [k, v] of Object.entries(params)) {
          if (v === undefined) continue;
          if (v instanceof Blob) form.append(k, v, "photo");
          else form.append(k, typeof v === "string" ? v : JSON.stringify(v));
        }
        payload = form;
      } else {
        payload = JSON.stringify(params);
        headers["content-type"] = "application/json";
      }
      const res = await this.fetchImpl(`${API_BASE}/bot${this.token}/${method}`, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: true; result: T }
        | {
            ok: false;
            error_code?: number;
            description?: string;
            parameters?: { retry_after?: number; migrate_to_chat_id?: number };
          }
        | null;
      if (body && body.ok === true) return { ok: true, result: body.result };
      const code = body?.ok === false ? (body.error_code ?? res.status) : res.status;
      const description = (body?.ok === false && body.description) || `HTTP ${res.status}`;
      const failure: Extract<TelegramResult<T>, { ok: false }> = { ok: false, code, description };
      if (body?.ok === false) {
        if (typeof body.parameters?.retry_after === "number")
          failure.retryAfter = body.parameters.retry_after;
        if (typeof body.parameters?.migrate_to_chat_id === "number") {
          failure.migrateToChatId = body.parameters.migrate_to_chat_id;
        }
      }
      return failure;
    } catch (err) {
      // A malformed token makes fetch throw "Failed to parse URL from <url>", token and all; this
      // text is logged and shown in the dashboard as the chat's last error.
      let description = err instanceof Error && err.name === "AbortError" ? "timed out" : String(err);
      if (this.token) description = description.split(this.token).join("<token>");
      logger.warn("telegram call failed", { method, error: description });
      return { ok: false, code: 0, description };
    } finally {
      clearTimeout(timer);
    }
  }

  getMe(): Promise<TelegramResult<TelegramUser>> {
    return this.call<TelegramUser>("getMe");
  }

  /** Sends HTML text; link previews are off so a card stays one card. */
  sendMessage(
    chatId: number | bigint,
    html: string,
    opts: { silent?: boolean } = {},
  ): Promise<TelegramResult<TelegramMessage>> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: String(chatId),
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_notification: opts.silent === true,
    });
  }

  /**
   * A photo with an HTML caption: bytes we fetched (uploaded as multipart) or an https URL for
   * Telegram to fetch itself. Same link rules as a message.
   */
  sendPhoto(
    chatId: number | bigint,
    photo: string | FetchedImage,
    captionHtml: string,
    opts: { silent?: boolean } = {},
  ): Promise<TelegramResult<TelegramMessage>> {
    return this.call<TelegramMessage>("sendPhoto", {
      chat_id: String(chatId),
      photo: typeof photo === "string" ? photo : new Blob([photo.bytes], { type: photo.contentType }),
      caption: captionHtml,
      parse_mode: "HTML",
      disable_notification: opts.silent === true,
    });
  }

  /**
   * Downloads a token's artwork so it can be uploaded to Telegram. Telegram fetching the URL
   * itself was the first design and showed no pictures at all: the launchers' images sit on
   * public IPFS gateways that answer Telegram's fetcher with 429s and timeouts, and Telegram
   * turns every such miss into a 400. Null when the fetch fails, times out, is not an image, or
   * is too big; the caller then tries the URL, then text.
   */
  async fetchImage(url: string): Promise<FetchedImage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
    try {
      // Redirects are followed by hand so every hop passes the same check as the first URL.
      let target = new URL(url);
      for (let hop = 0; ; hop++) {
        if (!(await isFetchableUrl(target, this.resolveHost))) {
          logger.warn("token artwork URL refused", { url: target.href });
          return null;
        }
        const res = await this.fetchImpl(target, { signal: controller.signal, redirect: "manual" });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          await res.body?.cancel().catch(() => undefined);
          if (!location || hop >= IMAGE_MAX_REDIRECTS) return null;
          target = new URL(location, target);
          continue;
        }
        const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (!res.ok || !contentType.startsWith("image/")) {
          await res.body?.cancel().catch(() => undefined);
          logger.info("token artwork not fetchable", { url, status: res.status, contentType });
          return null;
        }
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (declared > IMAGE_MAX_BYTES) {
          await res.body?.cancel().catch(() => undefined);
          return null;
        }
        // Capped while reading, not after: a body with no length header could be any size.
        const bytes = await readCapped(res, IMAGE_MAX_BYTES);
        if (!bytes || bytes.byteLength === 0) return null;
        return { bytes, contentType, sourceUrl: url };
      }
    } catch (err) {
      const description = err instanceof Error && err.name === "AbortError" ? "timed out" : String(err);
      logger.info("token artwork fetch failed", { url, error: description });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * An alert: the token's picture with the text as its caption when there is a picture and the
   * text fits a caption, else the text alone. The picture is fetched here and uploaded; if that
   * fails the URL is handed to Telegram to try; a picture Telegram won't take (a 400) costs
   * nothing but the retry as plain text, so an alert is never lost to its artwork.
   */
  async sendAlert(
    chatId: number | bigint,
    message: { html: string; imageUrl: string | null },
    opts: { silent?: boolean } = {},
  ): Promise<TelegramResult<TelegramMessage>> {
    if (message.imageUrl && captionLength(message.html) <= CAPTION_MAX_CHARS) {
      const fetched = await this.fetchImage(message.imageUrl);
      const withPhoto = await this.sendPhoto(chatId, fetched ?? message.imageUrl, message.html, opts);
      if (withPhoto.ok || withPhoto.code !== 400) return withPhoto;
      logger.warn("telegram refused the photo, sending the alert as text", {
        url: message.imageUrl,
        uploaded: fetched !== null,
        description: withPhoto.description,
      });
    }
    return this.sendMessage(chatId, message.html, opts);
  }

  getChatMember(chatId: number | bigint, userId: number): Promise<TelegramResult<{ status: string }>> {
    return this.call<{ status: string }>("getChatMember", { chat_id: String(chatId), user_id: userId });
  }

  setWebhook(url: string): Promise<TelegramResult<boolean>> {
    return this.call<boolean>("setWebhook", {
      url,
      secret_token: webhookSecret(this.token),
      allowed_updates: ["message", "my_chat_member"],
      drop_pending_updates: false,
    });
  }

  /** The bot's description under the chat list, and its command menu. Best effort. */
  async describeBot(): Promise<void> {
    await this.call("setMyCommands", {
      commands: [
        { command: "start", description: "Link this chat with a code from the Filters tab" },
        { command: "status", description: "Which account this chat is linked to" },
        { command: "show", description: "What each alert includes; /show reasons turns a part on" },
        { command: "hide", description: "Turn a part of the alert off, e.g. /hide links" },
        { command: "stop", description: "Stop alerts in this chat" },
      ],
    });
  }
}

/** The name a chat shows in the dashboard: a group's title, or the person's name. */
export function chatTitle(chat: TelegramChatInfo): string | null {
  if (chat.title) return chat.title.slice(0, 120);
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim();
  if (name) return name.slice(0, 120);
  return chat.username ? `@${chat.username}`.slice(0, 120) : null;
}

export function userDisplayName(user: TelegramUser): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return (name || (user.username ? `@${user.username}` : `user ${user.id}`)).slice(0, 120);
}
