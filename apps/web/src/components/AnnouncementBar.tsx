import { useEffect, useState } from "react";
import { usePolling } from "../hooks";
import { CloseIcon, InfoIcon } from "./Icons";

/** GET /announcement: what the Admin tab is broadcasting right now, if anything. */
export interface Announcement {
  id: string;
  message: string;
  severity: "info" | "warning";
  createdAt: string;
  expiresAt: string | null;
}

const DISMISSED_KEY = "ts.announcement.dismissed";
const REFRESH_EVENT = "ts:announcement";

/** Re-reads the announcement now: the Admin tab calls this after posting or ending one. */
export function refreshAnnouncement(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** Splits out http(s) links so an announcement can point somewhere; everything else is text. */
export function linkify(text: string): (string | { href: string })[] {
  const parts: (string | { href: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ href: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * The admin's announcement, as a slim bar above the page. Closing it hides that announcement in
 * this browser only; a new one (a new id) shows again. Only the latest dismissal is kept: one
 * announcement shows at a time, so that is the only one that could come back.
 */
export function AnnouncementBar() {
  const { data, reload } = usePolling<{ announcement: Announcement | null }>("/announcement", 120_000);
  useEffect(() => {
    window.addEventListener(REFRESH_EVENT, reload);
    return () => window.removeEventListener(REFRESH_EVENT, reload);
  }, [reload]);
  const [dismissed, setDismissed] = useState(readDismissed);
  const a = data?.announcement;
  if (!a || a.id === dismissed) return null;
  if (a.expiresAt && new Date(a.expiresAt).getTime() <= Date.now()) return null;

  const dismiss = () => {
    setDismissed(a.id);
    try {
      localStorage.setItem(DISMISSED_KEY, a.id);
    } catch {
      // Private mode or blocked storage: it stays closed until the page reloads.
    }
  };

  const warning = a.severity === "warning";
  return (
    <aside
      className={`announcement ${warning ? "warning" : "info"}`}
      role={warning ? "alert" : "status"}
      aria-label="Announcement"
    >
      <span className="announcement-icon" aria-hidden>
        <InfoIcon size={16} />
      </span>
      <p className="announcement-text">
        {linkify(a.message).map((part, i) =>
          typeof part === "string" ? (
            part
          ) : (
            <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
              {part.href}
            </a>
          ),
        )}
      </p>
      <button className="icon-btn announcement-close" onClick={dismiss} aria-label="Dismiss announcement">
        <CloseIcon size={16} />
      </button>
    </aside>
  );
}
