/**
 * Previews of a coin's X link (user ask 2026-10-18): the profile or post behind it, read from
 * FxTwitter's free public API (api.fxtwitter.com, no key; the same source the KOL pictures use)
 * rather than X's paid one, and served from here with the pictures, so the dashboard never loads
 * anything from X itself. Everything is kept in memory for a while: a coin's X link is shown on
 * every card that calls it, and the account behind it changes slowly.
 */

/** What a coin's X link points at, as far as a preview goes. */
export type XLink =
  | { kind: "profile"; handle: string }
  | { kind: "post"; handle: string; id: string }
  /** X shows communities only to signed-in readers, and FxTwitter can't read them. */
  | { kind: "community"; id: string };

/** The JSON GET /x-preview answers with. Picture fields are this API's own paths, or null. */
export type XPreview =
  | {
      kind: "profile";
      handle: string;
      name: string;
      verified: boolean;
      bio: string;
      followers: number | null;
      following: number | null;
      posts: number | null;
      joined: string | null;
      avatar: string | null;
      banner: string | null;
    }
  | {
      kind: "post";
      handle: string;
      name: string;
      verified: boolean;
      avatar: string | null;
      text: string;
      createdAt: string | null;
      replies: number | null;
      reposts: number | null;
      likes: number | null;
      views: number | null;
      media: string | null;
      mediaKind: "photo" | "video" | "gif" | null;
    }
  | { kind: "community"; id: string };

export type XPictureSlot = "avatar" | "banner" | "media";

/** A preview with the X picture URLs it shows, which only the image route reads. */
export interface ResolvedXPreview {
  preview: XPreview;
  pictures: Partial<Record<XPictureSlot, string>>;
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const ID = /^\d{1,20}$/;
/** X's own paths that look like a handle but aren't an account. */
const RESERVED = new Set([
  "home",
  "explore",
  "search",
  "notifications",
  "messages",
  "settings",
  "intent",
  "share",
  "hashtag",
  "login",
  "signup",
  "tos",
  "privacy",
  "compose",
  "i",
]);
const X_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "mobile.twitter.com",
  "mobile.x.com",
  "www.x.com",
  "www.twitter.com",
]);

/** What `url` points at on X, or null for anything else (another site, a search, a hashtag). */
export function parseXLink(url: string): XLink | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!X_HOSTS.has(u.hostname.toLowerCase())) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] === "i" && parts[1] === "communities" && parts[2] && ID.test(parts[2]))
    return { kind: "community", id: parts[2] };
  // x.com/i/status/<id> and x.com/i/web/status/<id> are posts without the author's handle.
  if (parts[0] === "i") {
    const at = parts.indexOf("status");
    const id = at > 0 ? parts[at + 1] : undefined;
    return id && ID.test(id) ? { kind: "post", handle: "i", id } : null;
  }
  const handle = parts[0]?.replace(/^@/, "");
  if (!handle || !HANDLE.test(handle) || RESERVED.has(handle.toLowerCase())) return null;
  if (parts[1] === "status" || parts[1] === "statuses") {
    const id = parts[2];
    return id && ID.test(id) ? { kind: "post", handle, id } : null;
  }
  return { kind: "profile", handle };
}

/** One cache entry per account or post, whatever URL spelling reached it. */
export function xLinkKey(link: XLink): string {
  if (link.kind === "post") return `s.${link.id}`;
  if (link.kind === "community") return `c.${link.id}`;
  return `p.${link.handle.toLowerCase()}`;
}

/** The link a cache key stands for, for the image route. Null for a key this API never made. */
export function xLinkFromKey(key: string): XLink | null {
  const [kind, value] = [key.slice(0, 2), key.slice(2)];
  if (kind === "s." && ID.test(value)) return { kind: "post", handle: "i", id: value };
  if (kind === "p." && HANDLE.test(value)) return { kind: "profile", handle: value };
  return null;
}

/** FxTwitter's answer for a missing account or post: nothing to preview, and that is settled. */
export class XPreviewMissing extends Error {}

const TIMEOUT_MS = 8_000;
const MAX_TEXT = 600;
const MAX_BIO = 300;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const verifiedOf = (u: Record<string, unknown>) =>
  (u.verification as { verified?: unknown } | undefined)?.verified === true;

function isoDate(v: unknown, seconds?: unknown): string | null {
  if (typeof seconds === "number" && Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString();
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Only X's own picture host, over https. Exported for tests. */
export function pictureUrl(raw: unknown, kind: "avatar" | "banner" | "media"): string | null {
  let u: URL;
  try {
    u = new URL(str(raw));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "pbs.twimg.com") return null;
  if (kind === "avatar") {
    if (u.pathname.includes("default_profile")) return null;
    // 200px: sharp at the card's 40px at any screen density, and still a few KB.
    u.pathname = u.pathname.replace(/_(normal|bigger|mini|200x200|400x400)(\.[a-z]+)?$/i, "_200x200$2");
    return u.toString();
  }
  if (kind === "banner") {
    if (!u.pathname.startsWith("/profile_banners/")) return null;
    if (!/\/\d+x\d+$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/$/, "")}/600x200`;
    return u.toString();
  }
  // Post photos and video stills: X's "small" size (up to 680px) is plenty for a 320px card.
  u.searchParams.delete("name");
  u.searchParams.set("name", "small");
  return u.toString();
}

/** The preview behind `link`, from FxTwitter. Throws XPreviewMissing for no such account or post, other errors for an outage. */
export async function fetchXPreview(link: XLink, fetchImpl: typeof fetch = fetch): Promise<ResolvedXPreview> {
  if (link.kind === "community") return { preview: { kind: "community", id: link.id }, pictures: {} };
  const key = xLinkKey(link);
  const path =
    link.kind === "post"
      ? `${encodeURIComponent(link.handle)}/status/${link.id}`
      : encodeURIComponent(link.handle);
  const res = await fetchImpl(`https://api.fxtwitter.com/${path}`, {
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // An unknown handle answers with a redirect or a 404; a private or deleted post with 401/404.
  if (res.status === 404 || res.status === 401 || (res.status >= 300 && res.status < 400))
    throw new XPreviewMissing();
  if (!res.ok) throw new Error(`FxTwitter answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || (typeof body.code === "number" && body.code !== 200)) {
    if (body?.code === 404 || body?.code === 401) throw new XPreviewMissing();
    throw new Error(`FxTwitter answered code ${String(body?.code)}`);
  }
  const image = (slot: XPictureSlot) => `/x-preview/image/${encodeURIComponent(key)}/${slot}`;

  if (link.kind === "profile") {
    const user = body.user as Record<string, unknown> | undefined;
    if (!user) throw new XPreviewMissing();
    const avatar = pictureUrl(user.avatar_url, "avatar");
    const banner = pictureUrl(user.banner_url, "banner");
    return {
      preview: {
        kind: "profile",
        handle: str(user.screen_name) || link.handle,
        name: clip(str(user.name), 80),
        verified: verifiedOf(user),
        bio: clip(str(user.description), MAX_BIO),
        followers: num(user.followers),
        following: num(user.following),
        posts: num(user.tweets),
        joined: isoDate(user.joined),
        avatar: avatar ? image("avatar") : null,
        banner: banner ? image("banner") : null,
      },
      pictures: { ...(avatar && { avatar }), ...(banner && { banner }) },
    };
  }

  const tweet = body.tweet as Record<string, unknown> | undefined;
  if (!tweet) throw new XPreviewMissing();
  const author = (tweet.author as Record<string, unknown> | undefined) ?? {};
  const avatar = pictureUrl(author.avatar_url, "avatar");
  const first = ((tweet.media as { all?: unknown[] } | undefined)?.all ?? [])[0] as
    { type?: unknown; url?: unknown; thumbnail_url?: unknown } | undefined;
  const mediaKind =
    first?.type === "photo" || first?.type === "video" || first?.type === "gif" ? first.type : null;
  const media = mediaKind
    ? pictureUrl(mediaKind === "photo" ? first?.url : first?.thumbnail_url, "media")
    : null;
  return {
    preview: {
      kind: "post",
      handle: str(author.screen_name) || link.handle,
      name: clip(str(author.name), 80),
      verified: verifiedOf(author),
      avatar: avatar ? image("avatar") : null,
      text: clip(str(tweet.text), MAX_TEXT),
      createdAt: isoDate(tweet.created_at, tweet.created_timestamp),
      replies: num(tweet.replies),
      reposts: num(tweet.retweets),
      likes: num(tweet.likes),
      views: num(tweet.views),
      media: media ? image("media") : null,
      mediaKind: media ? mediaKind : null,
    },
    pictures: { ...(avatar && { avatar }), ...(media && { media }) },
  };
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
/** A 680px photo is well under this; anything bigger is not one we asked for. */
export const MAX_PICTURE_BYTES = 768 * 1024;

export interface XPicture {
  bytes: Buffer;
  contentType: string;
}

/** A picture from pbs.twimg.com, or null when it is gone or isn't an image. Throws on an outage. */
export async function fetchXPicture(url: string, fetchImpl: typeof fetch = fetch): Promise<XPicture | null> {
  if (new URL(url).hostname !== "pbs.twimg.com") return null;
  const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404 || res.status === 403 || (res.status >= 300 && res.status < 400)) return null;
  if (!res.ok) throw new Error(`pbs.twimg.com answered ${res.status}`);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) return null;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PICTURE_BYTES) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_PICTURE_BYTES) return null;
  return { bytes, contentType };
}

/**
 * A small LRU with per-entry expiry, bounded by entry count and, optionally, by total size. A
 * Map keeps insertion order, so re-inserting on read makes the first key the least recently used.
 */
export class LruCache<V> {
  private map = new Map<string, { value: V; expiresAt: number; size: number }>();
  private total = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxSize = Infinity,
    private readonly sizeOf: (v: V) => number = () => 0,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.delete(key);
    const size = this.sizeOf(value);
    if (size > this.maxSize) return;
    this.map.set(key, { value, expiresAt: this.now() + ttlMs, size });
    this.total += size;
    while (this.map.size > this.maxEntries || this.total > this.maxSize) {
      const oldest = this.map.keys().next().value as string;
      this.delete(oldest);
    }
  }

  private delete(key: string): void {
    const hit = this.map.get(key);
    if (!hit) return;
    this.total -= hit.size;
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
