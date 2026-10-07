import { useState } from "react";
import { post } from "../api";
import { usePolling } from "../hooks";
import { shortAddress } from "../format";
import { refreshAnnouncement } from "../components/AnnouncementBar";
import { Load, Panel, Table, Tag, when } from "./adminShared";

/** Mirrors ANNOUNCEMENT_MAX_LENGTH in apps/api/src/routes/announcements.ts. */
const MAX_LENGTH = 500;

const EXPIRY_OPTIONS = [
  { hours: 0, label: "Until I end it" },
  { hours: 1, label: "1 hour" },
  { hours: 6, label: "6 hours" },
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
];

interface AnnouncementRow {
  id: string;
  createdAt: string;
  message: string;
  severity: "info" | "warning";
  expiresAt: string | null;
  endedAt: string | null;
  createdBy: string | null;
}

interface Announcements {
  currentId: string | null;
  history: AnnouncementRow[];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function status(a: AnnouncementRow, currentId: string | null) {
  if (a.id === currentId) return <Tag tone="ok">showing</Tag>;
  if (a.endedAt) return <Tag tone="muted">ended {when(a.endedAt)}</Tag>;
  return <Tag tone="muted">expired</Tag>;
}

/** Post a banner to every visitor's dashboard, end it, and see what went out before. */
export function AnnouncementsAdmin() {
  const q = usePolling<Announcements>("/admin/announcements", 60_000);
  const [message, setMessage] = useState("");
  const [severity, setSeverity] = useState<"info" | "warning">("info");
  const [hours, setHours] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const live = q.data?.history.find((a) => a.id === q.data?.currentId) ?? null;
  const trimmed = message.trim();

  const refresh = () => {
    // The admin's own banner changes on the spot, not at its next poll.
    refreshAnnouncement();
    q.reload();
  };

  const send = async () => {
    if (live && !window.confirm("This replaces the announcement showing now. Post it?")) return;
    setBusy(true);
    setResult(null);
    try {
      await post("/admin/announcements", {
        message: trimmed,
        severity,
        expiresInHours: hours || undefined,
      });
      setMessage("");
      setResult("Posted. Visitors see it within a couple of minutes.");
      refresh();
    } catch (e) {
      setResult(`Failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    if (!window.confirm("Take the announcement down for everyone?")) return;
    setBusy(true);
    setResult(null);
    try {
      await post("/admin/announcements/end");
      setResult("Ended.");
      refresh();
    } catch (e) {
      setResult(`Failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Panel
        title="New announcement"
        note="Shows as a bar at the top of every visitor's dashboard, signed in or not. One shows at a time; posting replaces the current one. Visitors can close it, and a new announcement shows again. Links starting with https:// become clickable."
      >
        <div className="announce-form">
          <textarea
            value={message}
            maxLength={MAX_LENGTH}
            placeholder="What should everyone see?"
            aria-label="Announcement message"
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="announce-row">
            <label className="small muted">
              Style
              <select value={severity} onChange={(e) => setSeverity(e.target.value as "info" | "warning")}>
                <option value="info">Info (blue)</option>
                <option value="warning">Warning (amber)</option>
              </select>
            </label>
            <label className="small muted">
              Show for
              <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.hours} value={o.hours}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="small faint">
              {trimmed.length}/{MAX_LENGTH}
            </span>
            <button className="button primary" disabled={busy || !trimmed} onClick={() => void send()}>
              Post announcement
            </button>
          </div>
        </div>
        {result && <p className="small muted">{result}</p>}
      </Panel>
      <Panel
        title="History"
        note="The newest 20."
        actions={
          live && (
            <button className="ghost small danger" disabled={busy} onClick={() => void end()}>
              End current
            </button>
          )
        }
      >
        <Load q={q}>
          {(d) => (
            <Table
              head={["Posted", "Message", "Style", "Expires", "Status", "By"]}
              empty="Nothing posted yet."
              rows={d.history.map((a) => [
                when(a.createdAt),
                <span className="announce-cell">{a.message}</span>,
                a.severity === "warning" ? <Tag tone="warn">warning</Tag> : <Tag tone="muted">info</Tag>,
                a.expiresAt ? new Date(a.expiresAt).toLocaleString() : "never",
                status(a, d.currentId),
                a.createdBy ? shortAddress(a.createdBy) : "–",
              ])}
            />
          )}
        </Load>
      </Panel>
    </div>
  );
}
