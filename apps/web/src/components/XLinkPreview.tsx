import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** Hover this long before the card shows, so sweeping the pointer across a feed opens nothing. */
const OPEN_DELAY_MS = 400;
/** Time to move from the link onto the card before it closes. */
const CLOSE_DELAY_MS = 180;
/** A press this long on a phone shows the card instead of opening the link. */
const LONG_PRESS_MS = 450;

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

// The card and its read load the first time a link is hovered, focused or pressed (XPreviewCard.tsx).
const loadCard = () => import("./XPreviewCard");
const XPreviewCard = lazy(() => loadCard().then((m) => ({ default: m.XPreviewCard })));
/** Starts the card's code and the link's preview read, so the card usually opens with both here. */
const warm = (url: string) => void loadCard().then((m) => m.loadPreview(url));

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
    warm(href);
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
    // The card's code, ahead of the long press that would open it.
    void loadCard();
    swallowClick.current = false;
    later(() => {
      press.current = null;
      swallowClick.current = true;
      warm(href);
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
            warm(href);
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
          <Suspense fallback={null}>
            <XPreviewCard
              id={`x-preview-${hrefId(href)}`}
              url={href}
              anchor={anchor}
              mode={open}
              onClose={close}
              onEnter={clear}
              onLeave={() => open === "hover" && later(close, CLOSE_DELAY_MS)}
            />
          </Suspense>,
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
