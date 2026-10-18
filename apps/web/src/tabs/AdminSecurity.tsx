import { useState } from "react";
import { usePolling } from "../hooks";
import { shortAddress } from "../format";
import { post } from "../api";
import { adminDownload, adminGet } from "../tradeConfirm";
import { Load, Panel, Table, Tag, n, when } from "./adminShared";

/**
 * The admin panel's record of itself (2026-10-18 admin panel audit): every admin write with who
 * made it (routes/admin.ts /actions, adminActionLog.ts), the weekly table backups and the nightly
 * full database dumps, whose downloads need the wallet's signature because they hold every user's
 * data.
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

interface DbDumpRow {
  name: string;
  kind: "nightly" | "pre-restore";
  takenAt: string | null;
  sizeBytes: number;
}

interface DbDumps {
  configured: boolean;
  dumps: DbDumpRow[];
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  runningSince: string | null;
  pending: { requestedAt: string } | null;
}

interface DbDumpLink {
  name: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  expiresAt: string;
}

const gb = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

/** Saves `text` as a small file next to the dump: restore.sh reads `<dump>.sha256` beside it. */
function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The nightly full database dumps (backup/dbDumps.ts, scripts/db-backup): pg_dump of the whole
 * database, zstd-compressed, in the dumps bucket. A download is a signed link the browser fetches
 * from the bucket itself, so a file of several GB streams to disk. "Dump now" queues the db-dump
 * job, which the backup cron picks up within 10 minutes.
 */
export function DbDumps() {
  const q = usePolling<DbDumps>("/admin/db-dumps", 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const download = async (d: DbDumpRow) => {
    if (
      !window.confirm(
        `This file is the whole database (${gb(d.sizeBytes)}): every user's wallet, Telegram chats, trading records and the trading wallets' sealed keys. Your wallet will be asked to approve the download. Keep it somewhere private and delete it after use.`,
      )
    )
      return;
    setBusy(d.name);
    setError(null);
    setResult(null);
    try {
      const link = await adminGet<DbDumpLink>(`/admin/db-dumps/${encodeURIComponent(d.name)}/download`);
      // The dump itself: the browser downloads it straight from the bucket, which names the file
      // (a cross-origin link's download attribute is ignored).
      const a = document.createElement("a");
      a.href = link.url;
      document.body.appendChild(a);
      a.click();
      a.remove();
      saveText(`${link.name.replace(/\.dump$/, "")}.sha256`, `${link.sha256}  ${link.name}\n`);
      setResult(
        `Downloading ${link.name} (${gb(link.sizeBytes)}) with its .sha256 beside it. sha256 ${link.sha256}. The link works until ${when(link.expiresAt)}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const dumpNow = async () => {
    if (
      !window.confirm(
        "Take a full database dump now? The backup job picks it up within 10 minutes and reads the whole database for the few minutes the dump takes.",
      )
    )
      return;
    setBusy("now");
    setError(null);
    setResult(null);
    try {
      const r = await post<{ queued: boolean; reason?: string }>("/admin/jobs/db-dump/run-now", {
        confirm: true,
      });
      setResult(
        r.queued
          ? "Queued. The backup job takes it within 10 minutes; it shows here once it is uploaded and verified."
          : `Not queued: ${r.reason ?? "refused"}.`,
      );
      q.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel
      title="Full database backups"
      note="pg_dump of the whole database, compressed, taken nightly at 02:30 UTC and checked by sha256. Downloading one needs your wallet's approval. Restore it with restore.sh (README, Backups and restore)."
      actions={
        <button className="button primary" disabled={busy !== null} onClick={() => void dumpNow()}>
          {busy === "now" ? "Queueing…" : "Dump now"}
        </button>
      }
    >
      {error && <p className="error">{error}</p>}
      {result && <p className="small muted">{result}</p>}
      <Load q={q}>
        {(d) => (
          <div className="stack">
            <p className="small muted">
              Last dump {when(d.lastSuccessAt)}
              {d.runningSince && (
                <>
                  {" "}
                  · <Tag tone="warn">dumping since {when(d.runningSince)}</Tag>
                </>
              )}
              {d.pending && (
                <>
                  {" "}
                  · <Tag tone="muted">queued {when(d.pending.requestedAt)}</Tag>
                </>
              )}
              {d.lastError && (
                <>
                  {" "}
                  · <Tag tone="bad">{d.lastError}</Tag>
                </>
              )}
            </p>
            {!d.configured ? (
              <p className="small muted">
                The API can't see the dumps bucket yet. Set DB_DUMP_S3_ENDPOINT, DB_DUMP_S3_BUCKET,
                DB_DUMP_S3_ACCESS_KEY_ID and DB_DUMP_S3_SECRET_ACCESS_KEY on trenchscanner-api, with a
                read-only token for that bucket (README, Backups and restore).
              </p>
            ) : (
              <Table
                head={["Taken", "Kind", "Size", ""]}
                rows={d.dumps.map((b) => [
                  when(b.takenAt),
                  b.kind === "nightly" ? "full" : <Tag tone="warn">before a restore</Tag>,
                  gb(b.sizeBytes),
                  <button
                    type="button"
                    className="small-btn"
                    disabled={busy !== null}
                    onClick={() => void download(b)}
                  >
                    {busy === b.name ? "Signing…" : "Download"}
                  </button>,
                ])}
                empty="No complete dumps in the bucket yet."
              />
            )}
          </div>
        )}
      </Load>
    </Panel>
  );
}
