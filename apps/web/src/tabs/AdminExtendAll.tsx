import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { CloseIcon } from "../components/Icons";
import { usePolling } from "../hooks";
import { adminCall } from "../tradeConfirm";
import { Load, Panel, Table, Wallet, n, when } from "./adminShared";

/**
 * Admin > Access: add weeks or months to every live subscription at once (user ask 2026-11-27),
 * at most three months a run. The API (routes/adminExtendAll.ts) holds every rule; this panel is
 * the extra step in front of it: a review dialog with the count and the new dates, a word to type,
 * then the wallet's signature.
 */

type Unit = "weeks" | "months";
/** The API's caps (core MAX_BULK_EXTENSION), so the form stops at them too. */
const MAX: Record<Unit, number> = { weeks: 12, months: 3 };

interface Preview {
  unit: Unit;
  amount: number;
  days: number;
  affected: number;
  soonestExpiry: string | null;
  latestExpiry: string | null;
  soonestAfter: string | null;
  latestAfter: string | null;
  confirmWord: string;
  lastRun: Run | null;
  cooldownUntil: string | null;
}

interface Run {
  requestId: string;
  at: string;
  by: string;
  fromPhone: boolean;
  unit: string;
  amount: number;
  days: number;
  usersExtended: number;
  replayed?: boolean;
}

function errorText(e: unknown) {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

const label = (amount: number, unit: string) => `${amount} ${amount === 1 ? unit.replace(/s$/, "") : unit}`;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "none");

export function ExtendAllSubscriptions({ onDone }: { onDone: () => void }) {
  const runs = usePolling<Run[]>("/admin/subscriptions/extend-all/runs", 60_000);
  const [unit, setUnit] = useState<Unit>("weeks");
  const [amount, setAmount] = useState("1");
  const count = Number(amount);
  const valid = Number.isInteger(count) && count >= 1 && count <= MAX[unit];
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const review = async () => {
    setBusy(true);
    setResult(null);
    try {
      setPreview(await api<Preview>(`/admin/subscriptions/extend-all/preview?unit=${unit}&amount=${count}`));
    } catch (e) {
      setResult(`Couldn't review: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Extend every subscription"
      note="Adds time to every live subscription at once, up to 3 months a run. Lapsed subscriptions, whitelisted wallets and Free Access are not changed."
    >
      <div className="admin-form">
        <input
          className="admin-days"
          type="number"
          min={1}
          max={MAX[unit]}
          step={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="How many"
        />
        <select
          value={unit}
          aria-label="Weeks or months"
          onChange={(e) => {
            const next = e.target.value as Unit;
            setUnit(next);
            if (Number(amount) > MAX[next]) setAmount(String(MAX[next]));
          }}
        >
          <option value="weeks">weeks</option>
          <option value="months">months</option>
        </select>
        <button className="button" disabled={busy || !valid} onClick={() => void review()}>
          Review extension
        </button>
      </div>
      {!valid && amount !== "" && (
        <p className="small error">
          Between 1 and {MAX[unit]} {unit}: a run adds at most 3 months.
        </p>
      )}
      {result && <p className="small muted">{result}</p>}
      <Load q={runs}>
        {(rows) =>
          rows.length === 0 ? (
            <p className="small faint">No extensions run yet.</p>
          ) : (
            <Table
              head={["When", "By", "Added", "Subscriptions"]}
              rows={rows.map((r) => [
                when(r.at),
                <span>
                  <Wallet address={r.by} />
                  {r.fromPhone ? " (phone)" : ""}
                </span>,
                `${label(r.amount, r.unit)} (${r.days} days)`,
                n(r.usersExtended),
              ])}
            />
          )
        }
      </Load>
      {preview && (
        <ConfirmDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onDone={(run) => {
            setPreview(null);
            setResult(
              run.replayed
                ? `That run had already gone through: ${n(run.usersExtended)} subscriptions got ${label(run.amount, run.unit)}.`
                : `Done. ${n(run.usersExtended)} subscriptions got ${label(run.amount, run.unit)} (${run.days} days) more.`,
            );
            runs.reload();
            onDone();
          }}
        />
      )}
    </Panel>
  );
}

/** The extra step: what is about to happen, a word to type, then the wallet's signature. */
function ConfirmDialog({
  preview,
  onClose,
  onDone,
}: {
  preview: Preview;
  onClose: () => void;
  onDone: (run: Run) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per review: a retry after a lost answer is recognised by the API, not run twice.
  const [requestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const matches = typed.trim() === preview.confirmWord;
  const cooling = preview.cooldownUntil !== null && new Date(preview.cooldownUntil) > new Date();
  const close = () => {
    if (!busy) onClose();
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await adminCall<Run>("/admin/subscriptions/extend-all", "POST", {
        unit: preview.unit,
        amount: preview.amount,
        expectedUsers: preview.affected,
        confirmWord: typed.trim(),
        requestId,
      });
      onDone(done);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal"
      aria-labelledby="extend-all-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="extend-all-title">Extend every subscription?</h2>
          <button className="ghost icon-btn" onClick={close} aria-label="Close" disabled={busy}>
            <CloseIcon size={16} />
          </button>
        </header>
        <p>
          This adds <strong>{label(preview.amount, preview.unit)}</strong> ({preview.days} days) to{" "}
          <strong>{n(preview.affected)} live subscriptions</strong>. It can't be undone from the panel.
        </p>
        {preview.affected > 0 && (
          <p className="small">
            Expiries now run from {date(preview.soonestExpiry)} to {date(preview.latestExpiry)}. After this
            they run from {date(preview.soonestAfter)} to {date(preview.latestAfter)}.
          </p>
        )}
        <p className="small muted">
          Lapsed subscriptions, whitelisted wallets and Free Access are not changed. Your wallet signs the
          request after you confirm.
        </p>
        {preview.lastRun && (
          <p className="small muted">
            Last run {when(preview.lastRun.at)}: {label(preview.lastRun.amount, preview.lastRun.unit)} to{" "}
            {n(preview.lastRun.usersExtended)} subscriptions.
          </p>
        )}
        {cooling ? (
          <p className="small error">
            An extension ran a few minutes ago. The next one can run after{" "}
            {new Date(preview.cooldownUntil!).toLocaleTimeString()}.
          </p>
        ) : preview.affected === 0 ? (
          <p className="small error">There are no live subscriptions to extend.</p>
        ) : (
          <>
            <label className="small">
              Type <strong>{preview.confirmWord}</strong> to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-label={`Type ${preview.confirmWord} to confirm`}
                disabled={busy}
              />
            </label>
            <div className="admin-form">
              <button className="button primary" disabled={!matches || busy} onClick={() => void run()}>
                {busy ? "Extending..." : `Extend ${n(preview.affected)} subscriptions`}
              </button>
              <button className="button" disabled={busy} onClick={close}>
                Cancel
              </button>
            </div>
          </>
        )}
        {error && <p className="small error">{error}</p>}
      </div>
    </dialog>
  );
}
