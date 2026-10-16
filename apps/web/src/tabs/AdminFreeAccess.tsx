import { useEffect, useState } from "react";
import { post, put } from "../api";
import { usePolling } from "../hooks";
import { Kpi, Load, Panel, Table, Tag, Wallet, n, when } from "./adminShared";

/**
 * Admin > Access > Free Access (apps/api/src/routes/adminFreeAccess.ts): a period when any wallet
 * that signs in gets full access, the switch that ends it early, and - before either - what the
 * cleanup at its end will delete. Turning it on and off each take two confirmations, the second
 * one typed.
 */

type Phase = "scheduled" | "open" | "running" | "ended";

interface Period {
  id: string;
  signInStartsAt: string;
  signInEndsAt: string;
  accessEndsAt: string;
  createdBy: string;
  createdAt: string;
  disabledAt: string | null;
  purgedAt: string | null;
  phase: Phase;
  /** When the cleanup may run: the end plus an hour's grace. */
  cleanupAt: string;
}

interface PlanRow {
  walletAddress: string;
  enrolledAt: string;
  createdAccount: boolean;
  action: "delete" | "keep";
  reason: string | null;
}

interface FreeAccessReport {
  now: string;
  period: Period | null;
  plan: {
    enrolled: number;
    deletes: number;
    keeps: number;
    kept: Record<string, number>;
    /** Fingerprint of which accounts it deletes; the switch-off sends it back. */
    digest: string;
    rows: PlanRow[];
  } | null;
  history: (Period & { enrolled: number; deleted: number })[];
}

/** The typed confirmation for switching Free Access on. */
export const ENABLE_PHRASE = "FREE ACCESS";
/** The typed confirmation for switching it off, which names the deletions it runs. */
export const disablePhrase = (deletes: number) => (deletes > 0 ? `DELETE ${deletes}` : "END FREE ACCESS");

/** A Date as a datetime-local input's value (local time, to the minute). */
export function toLocalInput(d: Date): string {
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Why the form's times can't be saved, or null - the API checks the same and has the last word. */
export function timesProblem(starts: Date, signInEnds: Date, accessEnds: Date, now: Date): string | null {
  if ([starts, signInEnds, accessEnds].some((d) => Number.isNaN(d.getTime())))
    return "Fill in all three times.";
  if (!(starts < signInEnds)) return "Sign-in has to close after it opens.";
  if (accessEnds < signInEnds) return "Access can't end before sign-in closes.";
  if (accessEnds <= now) return "Access has to end in the future.";
  if (accessEnds.getTime() - starts.getTime() > 90 * 86_400_000) return "A period can run at most 90 days.";
  return null;
}

const PHASE_TEXT: Record<Phase, string> = {
  scheduled: "Scheduled",
  open: "On: sign-in open",
  running: "On: sign-in closed",
  ended: "Ended: cleanup pending",
};

/** The period's own time when the form still shows it, else null. */
export const unchanged = (formValue: string, iso: string | undefined) =>
  iso !== undefined && toLocalInput(new Date(iso)) === formValue ? iso : null;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const at = (iso: string) => new Date(iso).toLocaleString();

export function FreeAccessAdmin({ onChanged }: { onChanged?: () => void }) {
  const q = usePolling<FreeAccessReport>("/admin/free-access", 30_000);
  const period = q.data?.period ?? null;
  const on = period !== null && period.phase !== "ended";
  const [starts, setStarts] = useState("");
  const [signInEnds, setSignInEnds] = useState("");
  const [accessEnds, setAccessEnds] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // The form shows the running period's times, or sensible defaults for a new one: sign-in open
  // from now for three days, access for a week.
  const periodKey = period
    ? `${period.id}:${period.signInStartsAt}:${period.signInEndsAt}:${period.accessEndsAt}`
    : "";
  useEffect(() => {
    if (period && period.phase !== "ended") {
      setStarts(toLocalInput(new Date(period.signInStartsAt)));
      setSignInEnds(toLocalInput(new Date(period.signInEndsAt)));
      setAccessEnds(toLocalInput(new Date(period.accessEndsAt)));
    } else {
      const now = Date.now();
      setStarts(toLocalInput(new Date(now)));
      setSignInEnds(toLocalInput(new Date(now + 3 * 86_400_000)));
      setAccessEnds(toLocalInput(new Date(now + 7 * 86_400_000)));
    }
    // Re-filled only when the period itself changes (periodKey), not on every poll.
  }, [periodKey]);

  const startsAt = new Date(starts);
  const signInEndsAt = new Date(signInEnds);
  const accessEndsAt = new Date(accessEnds);
  const problem = timesProblem(startsAt, signInEndsAt, accessEndsAt, new Date());

  const refresh = () => {
    q.reload();
    onChanged?.();
  };

  const save = async () => {
    const summary = [
      on ? "Change the Free Access times to:" : "Turn Free Access on:",
      "",
      `Any wallet that signs in from ${startsAt.toLocaleString()} until ${signInEndsAt.toLocaleString()} gets full access until ${accessEndsAt.toLocaleString()}.`,
      "",
      "An hour after it ends, or after you switch it off, every account it created is deleted with its data, unless it has subscribed, burned, been whitelisted or holds Burn Credits.",
    ].join("\n");
    if (!window.confirm(summary)) return;
    const typed = window.prompt(`Type ${ENABLE_PHRASE} to confirm.`);
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== ENABLE_PHRASE) {
      setResult("Not saved: the confirmation didn't match.");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      await put("/admin/free-access", {
        // A time left as it was goes back exactly, not as the form's minute: the API refuses to
        // move an opened period's start or to shorten its access.
        signInStartsAt: unchanged(starts, period?.signInStartsAt) ?? startsAt.toISOString(),
        signInEndsAt: unchanged(signInEnds, period?.signInEndsAt) ?? signInEndsAt.toISOString(),
        accessEndsAt: unchanged(accessEnds, period?.accessEndsAt) ?? accessEndsAt.toISOString(),
        confirm: true,
      });
      setResult(on ? "Times saved." : "Free Access is on.");
      refresh();
    } catch (e) {
      setResult(`Failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    const plan = q.data?.plan;
    if (!plan) return;
    const summary = [
      "Switch Free Access off now?",
      "",
      `${plan.enrolled} wallet${plan.enrolled === 1 ? "" : "s"} lose${plan.enrolled === 1 ? "s" : ""} access at once.`,
      plan.deletes > 0
        ? `In an hour, ${plan.deletes} account${plan.deletes === 1 ? " is" : "s are"} deleted for good with all their data (filters, matches, settings, linked phones and Telegram chats), less any that subscribe or burn meanwhile. This can't be undone.`
        : "No account is deleted.",
      plan.keeps > 0 ? `${plan.keeps} kept (see the list).` : "",
    ]
      .filter((l, i, all) => l !== "" || all[i - 1] !== "")
      .join("\n");
    if (!window.confirm(summary)) return;
    const phrase = disablePhrase(plan.deletes);
    const typed = window.prompt(`Type ${phrase} to confirm.`);
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== phrase) {
      setResult("Not switched off: the confirmation didn't match.");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const r = await post<{ period: Period }>("/admin/free-access/disable", {
        confirm: true,
        digest: plan.digest,
      });
      setResult(
        plan.deletes > 0 ? `Switched off. The cleanup runs at ${at(r.period.cleanupAt)}.` : "Switched off.",
      );
      refresh();
    } catch (e) {
      setResult(`Not switched off: ${errorText(e)}`);
      q.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Free Access"
      note="Let any wallet that signs in during a window use everything, for a set time. When it ends, the accounts it created are deleted unless they subscribed or another rule keeps them."
      actions={
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className={`switch${on ? " on" : ""}`}
          disabled={busy || !q.data || period?.phase === "ended" || (!on && problem !== null)}
          onClick={() => void (on ? disable() : save())}
        >
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          {on ? "On" : "Off"}
        </button>
      }
    >
      <Load q={q}>
        {(d) => (
          <div className="stack">
            {d.period && (
              <div className="kpis">
                <Kpi
                  label="Status"
                  value={PHASE_TEXT[d.period.phase]}
                  tone={d.period.phase === "ended" ? "warn" : undefined}
                />
                <Kpi
                  label="Sign-in"
                  value={at(d.period.signInStartsAt)}
                  sub={`until ${at(d.period.signInEndsAt)}`}
                />
                <Kpi
                  label={d.period.phase === "ended" ? "Ended" : "Access ends"}
                  value={at(d.period.disabledAt ?? d.period.accessEndsAt)}
                  sub={`cleanup ${at(d.period.cleanupAt)}`}
                />
                {d.plan && (
                  <Kpi
                    label="Enrolled"
                    value={n(d.plan.enrolled)}
                    sub={`${d.plan.deletes} to delete at the end · ${d.plan.keeps} kept`}
                    tone={d.plan.deletes > 0 ? "warn" : undefined}
                  />
                )}
              </div>
            )}
            {d.period?.phase !== "ended" && (
              <div className="admin-form">
                <label className="field">
                  Sign-in opens
                  <input
                    type="datetime-local"
                    value={starts}
                    // Fixed once sign-in has opened (the API refuses to move it).
                    disabled={d.period !== null && d.period.phase !== "scheduled"}
                    onChange={(e) => setStarts(e.target.value)}
                  />
                </label>
                <label className="field">
                  Sign-in closes
                  <input
                    type="datetime-local"
                    value={signInEnds}
                    onChange={(e) => setSignInEnds(e.target.value)}
                  />
                </label>
                <label className="field">
                  Access ends
                  <input
                    type="datetime-local"
                    value={accessEnds}
                    onChange={(e) => setAccessEnds(e.target.value)}
                  />
                </label>
                <button
                  className="button primary"
                  disabled={busy || problem !== null}
                  onClick={() => void save()}
                >
                  {on ? "Save times" : "Turn on"}
                </button>
              </div>
            )}
            {problem && d.period?.phase !== "ended" && <p className="small muted">{problem}</p>}
            {result && <p className="small muted">{result}</p>}
            {d.plan && d.plan.enrolled > 0 && (
              <>
                <p className="small muted">
                  What the cleanup does at the end, as things stand now
                  {Object.keys(d.plan.kept).length > 0 &&
                    ` (kept: ${Object.entries(d.plan.kept)
                      .map(([why, count]) => `${count} ${why}`)
                      .join(", ")})`}
                  .
                </p>
                <Table
                  head={["Wallet", "Signed in", "Account", "At the end"]}
                  rows={d.plan.rows.map((r) => [
                    <Wallet address={r.walletAddress} />,
                    when(r.enrolledAt),
                    r.createdAccount ? "new" : "existing",
                    r.action === "delete" ? (
                      <Tag tone="bad">delete</Tag>
                    ) : (
                      <Tag tone="ok">keep: {r.reason}</Tag>
                    ),
                  ])}
                />
              </>
            )}
            {d.history.length > 0 && (
              <Table
                head={["Past period", "Ended", "Enrolled", "Deleted"]}
                rows={d.history.map((h) => [
                  `${new Date(h.signInStartsAt).toLocaleDateString()} – ${new Date(h.accessEndsAt).toLocaleDateString()}`,
                  h.disabledAt ? `switched off ${when(h.disabledAt)}` : when(h.purgedAt),
                  n(h.enrolled),
                  n(h.deleted),
                ])}
              />
            )}
          </div>
        )}
      </Load>
    </Panel>
  );
}
