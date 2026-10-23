import { useState } from "react";
import { usePolling } from "../hooks";
import { Load, Panel, Tag, when } from "./adminShared";
import {
  groupRows,
  problemLines,
  rowProblem,
  type EnvCell,
  type EnvColumn,
  type EnvReport,
  type EnvSystem,
} from "./adminEnvView";

/** One service's view of one variable. */
function Cell({ c }: { c: EnvCell | undefined }) {
  if (!c) return <span className="faint">–</span>;
  const hint = c.hint ? <div className="faint small">{c.hint}</div> : null;
  if (c.state === "unknown") {
    return c.need ? <Tag tone="muted">not reported</Tag> : <span className="faint">–</span>;
  }
  if (c.state === "set") {
    return (
      <>
        {c.need ? <Tag tone="ok">set</Tag> : <Tag tone="muted">set, unused here</Tag>}
        {hint}
      </>
    );
  }
  const word = c.state === "empty" ? "blank" : "missing";
  if (c.need === "required") return <Tag tone="bad">{word}</Tag>;
  if (c.need === "expected") return <Tag tone="warn">{word}</Tag>;
  if (c.need === "optional") return <Tag tone="muted">off</Tag>;
  return <span className="faint">–</span>;
}

function ColumnHead({ c }: { c: EnvColumn }) {
  return (
    <th>
      {c.label}
      <div className="faint small" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
        {c.live ? "live" : c.reportedAt ? <>booted {when(c.reportedAt)}</> : "no report"}
        {c.commit && <> · {c.commit.slice(0, 7)}</>}
      </div>
    </th>
  );
}

function SystemGrid({ s, onlyProblems }: { s: EnvSystem; onlyProblems: boolean }) {
  if (s.status !== "ok") {
    return <p className={s.status === "error" ? "error small" : "muted small"}>{s.error}</p>;
  }
  const problems = problemLines(s);
  const groups = groupRows(onlyProblems ? s.rows.filter(rowProblem) : s.rows);
  return (
    <div className="stack">
      {problems.length === 0 ? (
        <p className="small">
          <Tag tone="ok">all set</Tag> Every required and expected variable is set on every service.
        </p>
      ) : (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {problems.map((p) => (
            <li key={p.text}>
              <Tag tone={p.severity}>{p.severity === "bad" ? "required" : "check"}</Tag> {p.text}
            </li>
          ))}
        </ul>
      )}
      {groups.length === 0 ? (
        <p className="muted small">Nothing to show.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Variable</th>
                {s.columns.map((c) => (
                  <ColumnHead key={c.id} c={c} />
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => [
                <tr key={`g-${g.group}`}>
                  <th colSpan={s.columns.length + 1}>{g.group}</th>
                </tr>,
                ...g.rows.map((r) => (
                  <tr key={r.key}>
                    <td style={{ whiteSpace: "normal", minWidth: 200 }}>
                      <code>{r.key}</code> {r.differs && <Tag tone="warn">differs</Tag>}
                      {r.note && <div className="faint small">{r.note}</div>}
                    </td>
                    {s.columns.map((c) => (
                      <td key={c.id}>
                        <Cell c={r.cells[c.id]} />
                      </td>
                    ))}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Admin > Environment: whether each env var a service is meant to have is set on it, for every
 * TrenchScanner service and TokenSage's. Values never leave the server: a secret shows its length,
 * a URL its host, and only plain settings their value.
 */
export function EnvAdmin() {
  const q = usePolling<EnvReport>("/admin/env", 120_000);
  const [onlyProblems, setOnlyProblems] = useState(false);
  return (
    <>
      <p className="muted small">
        The api is read live. Each worker reports when it boots, and Render applies an env change only by
        restarting the service, so a column shows what that service is running with now. A secret shows only
        its length, a URL only its host. Red is required, amber is expected (render.yaml ships it), and "off"
        is an optional feature left unset.
      </p>
      <label className="small">
        <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />{" "}
        Only rows with a problem
      </label>
      <Load q={q}>
        {(r) => (
          <div className="stack">
            {r.systems.map((s) => (
              <Panel key={s.id} title={s.label}>
                <SystemGrid s={s} onlyProblems={onlyProblems} />
              </Panel>
            ))}
          </div>
        )}
      </Load>
    </>
  );
}
