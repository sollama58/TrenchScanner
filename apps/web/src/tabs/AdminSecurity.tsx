import { useState } from "react";
import { usePolling } from "../hooks";
import { shortAddress } from "../format";
import { adminDownload } from "../tradeConfirm";
import { Load, Panel, Table, Tag, n, when } from "./adminShared";

/**
 * The admin panel's record of itself (2026-10-18 admin panel audit): every admin write with who
 * made it (routes/admin.ts /actions, adminActionLog.ts), and the weekly table backups, whose
 * download needs the wallet's signature because it holds every user's data.
 */

interface AdminActionRow {
  id: string;
  at: string;
  wallet: string;
  deviceId: string | null;
  method: string;
  route: string;
  detail: { params?: Record<string, unknown>; body?: unknown } | null;
  statusCode: number;
}

/** What a row changed, in one short line: the route's params, then the body's fields. */
export function actionSummary(detail: AdminActionRow["detail"]): string {
  if (!detail) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail.params ?? {})) parts.push(`${k}=${String(v)}`);
  const body = detail.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      parts.push(`${k}=${text.length > 40 ? `${text.slice(0, 40)}…` : text}`);
    }
  }
  return parts.join(" · ");
}

export function AdminActionLog() {
  const q = usePolling<AdminActionRow[]>("/admin/actions?limit=100", 60_000);
  return (
    <Panel
      title="Admin action log"
      note="Every admin change, newest 100, with the wallet and device that made it."
    >
      <Load q={q}>
        {(rows) => (
          <Table
            head={["When", "Admin", "From", "Action", "Details", "Result"]}
            rows={rows.map((r) => [
              when(r.at),
              shortAddress(r.wallet),
              r.deviceId ? <Tag tone="warn">phone</Tag> : "browser",
              `${r.method} ${r.route.replace(/^\/admin/, "")}`,
              actionSummary(r.detail) || "–",
              <Tag tone={r.statusCode < 400 ? "ok" : "bad"}>{r.statusCode}</Tag>,
            ])}
            empty="No admin changes recorded yet."
          />
        )}
      </Load>
    </Panel>
  );
}

interface TableBackupRow {
  id: string;
  createdAt: string;
  kind: string;
  rowCount: number;
  sizeBytes: number;
  offsiteAt: string | null;
  offsiteError: string | null;
}

export function TableBackups() {
  const q = usePolling<{ backups: TableBackupRow[] }>("/admin/table-backups", 300_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const download = async (b: TableBackupRow) => {
    if (
      !window.confirm(
        "This file holds every user's wallet, Telegram chats and trading records. Your wallet will be asked to approve the download. Keep it somewhere private.",
      )
    )
      return;
    setBusy(b.id);
    setError(null);
    try {
      await adminDownload(
        `/admin/table-backups/${encodeURIComponent(b.id)}/download`,
        "trenchscanner-tables.json.gz",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel
      title="Table backups"
      note="The weekly copies of the tables nothing can rebuild. Downloading one needs your wallet's approval."
    >
      {error && <p className="error">{error}</p>}
      <Load q={q}>
        {(d) => (
          <Table
            head={["Taken", "Rows", "Size", "Off-site", ""]}
            rows={d.backups.map((b) => [
              when(b.createdAt),
              n(b.rowCount),
              `${Math.round(b.sizeBytes / 1024)} KB`,
              b.offsiteAt ? <Tag tone="ok">copied</Tag> : b.offsiteError ? <Tag tone="bad">failed</Tag> : "–",
              <button
                type="button"
                className="small-btn"
                disabled={busy !== null}
                onClick={() => void download(b)}
              >
                {busy === b.id ? "Downloading…" : "Download"}
              </button>,
            ])}
            empty="No table backups yet."
          />
        )}
      </Load>
    </Panel>
  );
}
