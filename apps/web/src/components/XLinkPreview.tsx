import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { api, ApiError, API_URL } from "../api";
import { ago } from "../format";
import { ExternalIcon, XLogoIcon } from "./Icons";

/** Mirrors apps/api/src/xPreview.ts XPreview. Picture fields are API paths. */
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

type Loaded = { preview: XPreview } | { error: "missing" | "unavailable" };

/** Hover this long before the card shows, so sweeping the pointer across a feed opens nothing. */
const OPEN_DELAY_MS = 400;
/** Time to move from the link onto the card before it closes. */
const CLOSE_DELAY_MS = 180;
/** A press this long on a phone shows the card instead of opening the link. */
const LONG_PRESS_MS = 450;
const CARD_WIDTH = 320;

const X_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "www.x.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "mobile.x.com",
]);

/** Whether `url` is an X link worth asking the API about. The API checks it properly. */
export function isXLink(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && X_HOSTS.has(u.hostname.toLowerCase()) && u.pathname.length > 1;
  } catch {
    return false;
  }
}

/**
 * One read per link, shared by every card that shows it, and read again once it is old: a failed
 * read after a minute so a blip at X doesn't stick, a "not found" after ten (an account just made,
 * or back from suspension), and a preview after fifteen so its counts don't freeze for the page's life.
 */
const loads = new Map<string, Promise<Loaded>>();
const FAILED_FOR_MS = 60_000;
const MISSING_FOR_MS = 10 * 60_000;
const PREVIEW_FOR_MS = 15 * 60_000;
function loadPreview(url: string): Promise<Loaded> {
  let p = loads.get(url);
  if (!p) {
    const forget = (ms: number) =>
      setTimeout(() => {
        if (loads.get(url) === p) loads.delete(url);
      }, ms);
    p = api<XPreview>(`/x-preview?url=${encodeURIComponent(url)}`)
      .then((preview): Loaded => {
        forget(PREVIEW_FOR_MS);
        return { preview };
      })
      .catch((e: unknown): Loaded => {
        const missing = e instanceof ApiError && (e.status === 404 || e.status === 400);
        forget(missing ? MISSING_FOR_MS : FAILED_FOR_MS);
        return { error: missing ? "missing" : "unavailable" };
      });
    loads.set(url, p);
  }
  return p;
}

/** "1.2K", "3.4M": X's own way of writing counts. Exported for tests. */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

/** Where the card goes: under the link when it fits, else above it, kept inside the window. Exported for tests. */
export function placeCard(
  anchor: { top: number; bottom: number; left: number; width: number },
  card: { width: number; height: number },
  view: { width: number; height: number },
  gap = 8,
): { top: number; left: number; above: boolean } {
  const margin = 8;
  const below = anchor.bottom + gap;
  const above = view.height - below < card.height + margin && anchor.top - gap - card.height >= margin;
  const top = above
    ? anchor.top - gap - card.height
    : Math.min(below, Math.max(margin, view.height - card.height - margin));
  const centered = anchor.left + anchor.width / 2 - card.width / 2;
  const left = Math.max(margin, Math.min(centered, view.width - card.width - margin));
  return { top, left, above };
}

/**
 * An X link that previews the account or post behind it (user ask 2026-10-18): hover it on a
 * computer, or press and hold it on a phone. The preview comes from our API (GET /x-preview),
 * which reads it through FxTwitter and serves the pictures itself, so the browser never loads
 * anything from X. A plain click or tap still opens the link.
 */
export function XLinkPreview({
  href,
  children,
  title,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) {
  const anchor = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState<null | "hover" | "press">(null);
  const timer = useRef<number | undefined>(undefined);
  const press = useRef<{ x: number; y: number } | null>(null);
  /** Set when a long press opened the card: the click that ends the press must not open the link. */
  const swallowClick = useRef(false);
  const previewable = isXLink(href);

  const clear = () => window.clearTimeout(timer.current);
  const later = (fn: () => void, ms: number) => {
    clear();
    timer.current = window.setTimeout(fn, ms);
  };
  useEffect(() => clear, []);

  const close = useCallback(() => {
    clear();
    setOpen(null);
  }, []);

  if (!previewable) {
    return (
      <a href={href} title={title} {...rest}>
        {children}
      </a>
    );
  }

  const onPointerEnter = (e: ReactPointerEvent) => {
    if (e.pointerType === "touch") return;
    void loadPreview(href);
    later(() => setOpen("hover"), open ? 0 : OPEN_DELAY_MS);
  };
  const onPointerLeave = (e: ReactPointerEvent) => {
    if (e.pointerType === "touch") return;
    if (open === "hover") later(close, CLOSE_DELAY_MS);
    else if (!open) clear();
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType !== "touch") return;
    press.current = { x: e.clientX, y: e.clientY };
    swallowClick.current = false;
    later(() => {
      press.current = null;
      swallowClick.current = true;
      void loadPreview(href);
      setOpen("press");
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) {
      press.current = null;
      clear();
    }
  };
  const onPointerUp = () => {
    if (press.current) {
      press.current = null;
      clear();
    }
  };

  return (
    <>
      <a
        ref={anchor}
        href={href}
        {...rest}
        // No title: the browser's own tooltip would sit on top of the preview.
        className={`${rest.className ?? ""} x-preview-link`.trim()}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onFocus={(e) => {
          rest.onFocus?.(e);
          if (e.currentTarget.matches(":focus-visible")) {
            void loadPreview(href);
            later(() => setOpen("hover"), OPEN_DELAY_MS);
          }
        }}
        onBlur={(e) => {
          rest.onBlur?.(e);
          if (open === "hover") later(close, CLOSE_DELAY_MS);
          else if (!open) clear();
        }}
        onKeyDown={(e) => {
          rest.onKeyDown?.(e);
          if (e.key === "Escape" && open) close();
        }}
        onContextMenu={(e) => {
          // The phone's own link menu would cover the card a long press just opened.
          if (swallowClick.current || press.current) e.preventDefault();
          rest.onContextMenu?.(e);
        }}
        onClick={(e) => {
          if (swallowClick.current) {
            swallowClick.current = false;
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          rest.onClick?.(e);
        }}
        aria-describedby={open ? `x-preview-${hrefId(href)}` : rest["aria-describedby"]}
      >
        {children}
      </a>
      {open &&
        createPortal(
          <XPreviewCard
            id={`x-preview-${hrefId(href)}`}
            url={href}
            anchor={anchor}
            mode={open}
            onClose={close}
            onEnter={clear}
            onLeave={() => open === "hover" && later(close, CLOSE_DELAY_MS)}
          />,
          // Inside a modal dialog when the link is in one: the dialog sits in the browser's top
          // layer, above anything portaled to the body.
          anchor.current?.closest("dialog") ?? document.body,
        )}
    </>
  );
}

function hrefId(href: string): string {
  let h = 0;
  for (let i = 0; i < href.length; i++) h = (h * 31 + href.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function XPreviewCard({
  id,
  url,
  anchor,
  mode,
  onClose,
  onEnter,
  onLeave,
}: {
  id: string;
  url: string;
  anchor: React.RefObject<HTMLAnchorElement | null>;
  mode: "hover" | "press";
  onClose: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    void loadPreview(url).then((l) => live && setLoaded(l));
    return () => {
      live = false;
    };
  }, [url]);

  // Placed after every render: the card grows once the preview and its pictures arrive.
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const c = ref.current;
    if (!a || !c) return;
    const width = Math.min(CARD_WIDTH, window.innerWidth - 16);
    const next = placeCard(
      a,
      { width, height: c.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos((p) => (p && p.top === next.top && p.left === next.left && p.above === next.above ? p : next));
  });

  // A scroll moves the link out from under the card; a tap elsewhere is done with it.
  useEffect(() => {
    const onScroll = () => onClose();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={`x-preview${pos?.above ? " above" : ""}${mode === "press" ? " pressed" : ""}`}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: Math.min(CARD_WIDTH, typeof window === "undefined" ? CARD_WIDTH : window.innerWidth - 16),
        visibility: pos ? "visible" : "hidden",
      }}
      onPointerEnter={(e) => e.pointerType !== "touch" && onEnter()}
      onPointerLeave={(e) => e.pointerType !== "touch" && onLeave()}
      // Portaled, but React still bubbles its events to the card it came from (which opens the
      // coin on a click): keep them here.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {!loaded ? (
        <XPreviewSkeleton />
      ) : "error" in loaded ? (
        <p className="x-preview-note">
          {loaded.error === "missing"
            ? "Nothing to preview: the account or post may be gone, suspended or private."
            : "X previews aren't available right now."}
        </p>
      ) : (
        <XPreviewBody preview={loaded.preview} />
      )}
      <a
        className="x-preview-open"
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        onClick={onClose}
      >
        <XLogoIcon size={11} />
        Open on X
        <ExternalIcon size={10} />
      </a>
    </div>
  );
}

function XPreviewSkeleton() {
  return (
    <div className="x-preview-skeleton" aria-label="Loading the X preview">
      <span className="x-sk-avatar" />
      <span className="x-sk-lines">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

function Picture({ src, className }: { src: string | null; className: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return (
    <img
      className={className}
      src={`${API_URL}${src}`}
      alt=""
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function Who({ preview }: { preview: Extract<XPreview, { handle: string }> }) {
  return (
    <span className="x-who">
      <span className="x-name">
        <span className="x-name-text">{preview.name || `@${preview.handle}`}</span>
        {preview.verified && <VerifiedBadge />}
      </span>
      <span className="x-handle">@{preview.handle}</span>
    </span>
  );
}

/** X's verified mark: a check in a scalloped badge. */
function VerifiedBadge() {
  return (
    <svg className="x-verified" width={14} height={14} viewBox="0 0 24 24" aria-label="Verified" role="img">
      <path
        fill="currentColor"
        d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91C2.63 9.33 1.75 10.57 1.75 12s.88 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"
      />
      <path fill="var(--surface-solid)" d="M10.54 16.2 6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36z" />
    </svg>
  );
}

function Stat({ n, label }: { n: number | null; label: string }) {
  if (n === null) return null;
  return (
    <span className="x-stat">
      <b className="num">{compactCount(n)}</b> {label}
    </span>
  );
}

/** "3h ago" for a recent post, its date for an older one. */
function postedText(iso: string): string {
  const t = Date.parse(iso);
  if (Date.now() - t < 7 * 86_400_000) return ago(iso);
  const old = new Date(t).getFullYear() !== new Date().getFullYear();
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(old && { year: "numeric" }),
  });
}

function joinedText(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function XPreviewBody({ preview }: { preview: XPreview }) {
  if (preview.kind === "community") {
    return (
      <div className="x-preview-body">
        <span className="x-who">
          <span className="x-name">X Community</span>
        </span>
        <p className="x-text muted">
          X shows communities only to signed-in readers, so there is no preview. Open it on X to see who is in
          it.
        </p>
      </div>
    );
  }
  if (preview.kind === "profile") {
    return (
      <div className="x-preview-body x-profile">
        {preview.banner ? (
          <Picture src={preview.banner} className="x-banner" />
        ) : (
          <span className="x-banner x-banner-empty" />
        )}
        <div className="x-profile-head">
          <span className="x-avatar-ring">
            <Picture src={preview.avatar} className="x-avatar" />
          </span>
          <Who preview={preview} />
        </div>
        {preview.bio && <p className="x-text">{preview.bio}</p>}
        <div className="x-stats">
          <Stat n={preview.followers} label="followers" />
          <Stat n={preview.following} label="following" />
          <Stat n={preview.posts} label="posts" />
        </div>
        {preview.joined && <p className="x-meta">Joined {joinedText(preview.joined)}</p>}
      </div>
    );
  }
  return (
    <div className="x-preview-body x-post">
      <div className="x-post-head">
        <span className="x-avatar-ring small">
          <Picture src={preview.avatar} className="x-avatar" />
        </span>
        <Who preview={preview} />
        {preview.createdAt && <span className="x-meta x-when">{postedText(preview.createdAt)}</span>}
      </div>
      {preview.text && <p className="x-text">{preview.text}</p>}
      {preview.media && (
        <span className="x-media">
          <Picture src={preview.media} className="x-media-img" />
          {preview.mediaKind === "video" && <span className="x-media-tag">Video</span>}
          {preview.mediaKind === "gif" && <span className="x-media-tag">GIF</span>}
        </span>
      )}
      <div className="x-stats">
        <Stat n={preview.replies} label="replies" />
        <Stat n={preview.reposts} label="reposts" />
        <Stat n={preview.likes} label="likes" />
        <Stat n={preview.views} label="views" />
      </div>
    </div>
  );
}
