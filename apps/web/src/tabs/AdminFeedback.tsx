import { useState } from "react";
import { api, del, patch } from "../api";
import { invalidate } from "../cache";
import { shortAddress } from "../format";
import { usePolling } from "../hooks";
import { BugIcon, StarIcon, TrashIcon } from "../components/Icons";
import { REPORT_COUNTS_PATH, type ReportCounts } from "../components/AdminReportsBadge";
import { Load, Panel, Tag, Wallet, when } from "./adminShared";

type Status = "new" | "seen" | "done";
type StatusFilter = Status | "all";
type KindFilter = "all" | "bug" | "idea";

interface ReportContext {
  url?: string;
  tab?: string;
  appVersion?: string;
  viewport?: string;
  screen?: string;
  dpr?: number;
  userAgent?: string;
  theme?: string;
  language?: string;
  timezone?: string;
  signedIn?: boolean;
  guest?: boolean;
}

interface Report {
  id: string;
  createdAt: string;
  kind: "bug" | "idea";
  message: string;
  contact: string | null;
  status: Status;
  walletAddress: string | null;
  context: ReportContext | null;
  adminNote: string | null;
  handledBy: string | null;
  hasScreenshot: boolean;
}

interface Reports {
  reports: Report[];
  counts: ReportCounts;
}

const STATUS_TONE: Record<Status, "warn" | "muted" | "ok"> = { new: "warn", seen: "muted", done: "ok" };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The report's page as a link target, only when it is plain http(s). The sender writes this
 * field, so a javascript: or data: URL must never become a clickable href.
 */
export function safePageUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A screenshot the API handed back, only as a raster image data URL (never SVG or HTML). */
export const isImageDataUrl = (v: string) => /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v);

/** "Chrome 131 on Android": enough to tell browsers apart without the whole user agent. */
export function browserName(ua: string | undefined): string | null {
  if (!ua) return null;
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  const version = (re: RegExp) => re.exec(ua)?.[1];
  const edge = version(/Edg\/(\d+)/);
  const chrome = version(/(?:Chrome|CriOS)\/(\d+)/);
  const firefox = version(/(?:Firefox|FxiOS)\/(\d+)/);
  const safari = version(/Version\/(\d+).*Safari/);
  const browser = edge
    ? `Edge ${edge}`
    : chrome
      ? `Chrome ${chrome}`
      : firefox
        ? `Firefox ${firefox}`
        : safari
          ? `Safari ${safari}`
          : null;
  if (!browser && !os) return null;
  return [browser, os].filter(Boolean).join(" on ");
}

/** The bug button's reports and suggestions: read, mark seen or done, note, delete spam. */
export function FeedbackAdmin() {
  const [status, setStatus] = useState<StatusFilter>("new");
  const [kind, setKind] = useState<KindFilter>("all");
  const q = usePolling<Reports>(`/admin/feedback?status=${status}&kind=${kind}&limit=100`, 60_000);
  const counts = q.data?.counts;

  const refresh = () => {
    invalidate(REPORT_COUNTS_PATH);
    invalidate("/admin/feedback?");
    q.reload();
  };

  const filters: { id: StatusFilter; label: string }[] = [
    { id: "new", label: `New${counts ? ` (${counts.new})` : ""}` },
    { id: "seen", label: `Seen${counts ? ` (${counts.seen})` : ""}` },
    { id: "done", label: `Done${counts ? ` (${counts.done})` : ""}` },
    { id: "all", label: "All" },
  ];

  return (
    <Panel
      title="Reports"
      note="Bug reports and suggestions from the bug button at the bottom right of every screen. Anyone can send one, guests too; each comes with where they were in the app."
      actions={
        <div className="reports-filters">
          <div className="segmented small" role="group" aria-label="Status">
            {filters.map((f) => (
              <button
                key={f.id}
                className={status === f.id ? "on" : ""}
                aria-pressed={status === f.id}
                onClick={() => setStatus(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="segmented small" role="group" aria-label="Kind">
            {(
              [
                ["all", "Both"],
                ["bug", "Bugs"],
                ["idea", "Suggestions"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={kind === id ? "on" : ""}
                aria-pressed={kind === id}
                onClick={() => setKind(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <Load q={q}>
        {(d) =>
          d.reports.length === 0 ? (
            <p className="muted small">
              {status === "new" ? "Nothing new. You're all caught up." : "No reports here."}
            </p>
          ) : (
            <ul className="reports-list">
              {d.reports.map((r) => (
                <ReportItem key={r.id} report={r} onChanged={refresh} />
              ))}
            </ul>
          )
        }
      </Load>
    </Panel>
  );
}

function ReportItem({ report: r, onChanged }: { report: Report; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [note, setNote] = useState(r.adminNote ?? "");
  const c = r.context ?? {};
  const browser = browserName(c.userAgent);
  const link = safePageUrl(c.url);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const setStatus = (status: Status) =>
    run(() => patch(`/admin/feedback/${encodeURIComponent(r.id)}`, { status }));
  const saveNote = () =>
    run(() => patch(`/admin/feedback/${encodeURIComponent(r.id)}`, { adminNote: note.trim() || null }));
  const remove = () => {
    if (!window.confirm("Delete this report for good? Use this for spam.")) return;
    void run(() => del(`/admin/feedback/${encodeURIComponent(r.id)}`));
  };
  const showShot = async () => {
    setBusy(true);
    setError(null);
    try {
      const { screenshot } = await api<{ screenshot: string }>(
        `/admin/feedback/${encodeURIComponent(r.id)}/screenshot`,
      );
      if (!isImageDataUrl(screenshot)) throw new Error("that screenshot isn't an image");
      setShot(screenshot);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  /**
   * The full-size image in a new browser tab (a data: URL can't be opened directly). Decoded here
   * rather than with fetch(), which the site's connect-src policy refuses for data: URLs.
   */
  const openShot = () => {
    if (!shot) return;
    const [head, body] = shot.split(",", 2);
    const type = /^data:(image\/(?:jpeg|png|webp));base64$/.exec(head ?? "")?.[1];
    if (!type || !body) return;
    const bytes = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
    const blob = new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const facts = [
    c.tab && `Tab: ${c.tab}`,
    c.appVersion && `Version ${c.appVersion}`,
    c.viewport && `Window ${c.viewport}`,
    c.screen && `Screen ${c.screen}${c.dpr ? ` @${c.dpr}x` : ""}`,
    browser,
    c.theme && `Theme ${c.theme}`,
    c.language,
    c.timezone,
  ].filter(Boolean) as string[];

  return (
    <li className={`report report-${r.status}`}>
      <header className="report-head">
        <span className={`report-kind report-kind-${r.kind}`}>
          {r.kind === "bug" ? <BugIcon size={13} /> : <StarIcon size={13} />}
          {r.kind === "bug" ? "Bug" : "Suggestion"}
        </span>
        <Tag tone={STATUS_TONE[r.status]}>{r.status}</Tag>
        <span className="small muted">{when(r.createdAt)}</span>
        <span className="small muted report-from">
          from{" "}
          {r.walletAddress ? (
            <Wallet address={r.walletAddress} />
          ) : c.guest ? (
            "a guest"
          ) : (
            "someone signed out"
          )}
        </span>
        {r.contact && <span className="small report-contact">Contact: {r.contact}</span>}
      </header>
      <p className="report-message">{r.message}</p>
      {facts.length > 0 && <p className="small faint report-facts">{facts.join(" · ")}</p>}
      {c.url && (
        <p className="small faint report-url">
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer">
              {link}
            </a>
          ) : (
            c.url
          )}
        </p>
      )}
      {shot && (
        <button type="button" className="report-shot" onClick={openShot} title="Open full size">
          <img src={shot} alt="The sender's screenshot" />
        </button>
      )}
      <div className="report-note">
        <input
          type="text"
          value={note}
          maxLength={1000}
          placeholder="Note for other admins (what was done, a PR link)"
          aria-label="Admin note"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void saveNote();
          }}
        />
        {note.trim() !== (r.adminNote ?? "") && (
          <button className="small-btn" disabled={busy} onClick={() => void saveNote()}>
            Save note
          </button>
        )}
      </div>
      <div className="report-actions">
        {r.status !== "seen" && (
          <button className="ghost small-btn" disabled={busy} onClick={() => void setStatus("seen")}>
            {r.status === "done" ? "Reopen" : "Mark seen"}
          </button>
        )}
        {r.status !== "done" && (
          <button className="ghost small-btn" disabled={busy} onClick={() => void setStatus("done")}>
            Mark done
          </button>
        )}
        {r.hasScreenshot && !shot && (
          <button className="ghost small-btn" disabled={busy} onClick={() => void showShot()}>
            Show screenshot
          </button>
        )}
        <button
          className="ghost icon-btn danger"
          disabled={busy}
          onClick={remove}
          aria-label="Delete this report"
          title="Delete (spam)"
        >
          <TrashIcon size={15} />
        </button>
        {r.handledBy && r.status !== "new" && (
          <span className="small faint">by {shortAddress(r.handledBy)}</span>
        )}
        {error && <span className="error small">{error}</span>}
      </div>
    </li>
  );
}
