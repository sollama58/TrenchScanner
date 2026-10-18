import { createHash } from "node:crypto";

/**
 * A KOL's X profile picture (user ask 2026-10-18), without X's paid API: FxTwitter's public
 * profile endpoint (api.fxtwitter.com/<handle>, no key) gives the picture's pbs.twimg.com URL, and
 * the picture is read from there at 73px ("_bigger"), enough for a 36px avatar at 2x. Read by the
 * worker (kolAvatars.ts) and stored, so the dashboard never loads anything from X itself.
 */

export type XAvatar =
  | { status: "ok"; image: Buffer; contentType: string; hash: string }
  /** No account, or one still on X's default picture: the dashboard keeps its letter. */
  | { status: "none" };

const HANDLE = /^[A-Za-z0-9_]{1,30}$/;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
/** A 73px picture is a few KB; anything this big is not one. */
const MAX_IMAGE_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

/** The lower-case handle a picture is stored under, or null for one that isn't a valid X handle. */
export function avatarHandle(twitter: string | null | undefined): string | null {
  const h = (twitter ?? "").replace(/^@+/, "").trim();
  return HANDLE.test(h) ? h.toLowerCase() : null;
}

/** The 73px size of a pbs.twimg.com profile picture URL ("…_normal.jpg" → "…_bigger.jpg"). Exported for tests. */
export function biggerAvatarUrl(url: string): string {
  return url.replace(/_normal(\.[a-z]+)?$/i, "_bigger$1");
}

/**
 * Reads `handle`'s picture. Throws on an outage or a rate limit (try again later); resolves
 * "none" only when the answer is that there is no picture.
 */
export async function fetchXAvatar(handle: string, fetchImpl: typeof fetch = fetch): Promise<XAvatar> {
  if (!HANDLE.test(handle)) return { status: "none" };
  const profile = await fetchImpl(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // An unknown handle answers with a redirect or a 404.
  if (profile.status === 404 || (profile.status >= 300 && profile.status < 400)) return { status: "none" };
  if (!profile.ok) throw new Error(`FxTwitter answered ${profile.status} for @${handle}`);
  const body = (await profile.json().catch(() => null)) as { user?: { avatar_url?: unknown } } | null;
  const raw = body?.user?.avatar_url;
  if (typeof raw !== "string" || raw.length === 0) return { status: "none" };
  let url: URL;
  try {
    url = new URL(biggerAvatarUrl(raw));
  } catch {
    return { status: "none" };
  }
  // Only X's own image host, and never its default egg.
  if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com") return { status: "none" };
  if (url.pathname.includes("default_profile")) return { status: "none" };
  const res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return { status: "none" };
  if (!res.ok) throw new Error(`pbs.twimg.com answered ${res.status} for @${handle}`);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) return { status: "none" };
  const image = Buffer.from(await res.arrayBuffer());
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES) return { status: "none" };
  return {
    status: "ok",
    image,
    contentType,
    hash: createHash("sha256").update(image).digest("hex").slice(0, 12),
  };
}
