import type { ReactNode } from "react";
import { Skeleton } from "../components/Charts";
import type { Loadable } from "../hooks";
import { ago, shortAddress } from "../format";

/** The building blocks every Admin section shares: panels, tables, KPI tiles and formatters. */

export function Panel({
  title,
  note,
  children,
  actions,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <h2>{title}</h2>
          {note && <p className="muted small">{note}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/** Data, a skeleton while it first loads, or the error. */
export function Load<T>({ q, children }: { q: Loadable<T>; children: (data: T) => ReactNode }) {
  if (q.data)
    return (
      <div className={q.stale ? "stale" : ""}>
        {/* A later poll failing (API or database down) must not read as "all healthy" here. */}
        {q.error && (
          <p className="error small">Refresh failed: {q.error.message}. Showing the last answer.</p>
        )}
        {children(q.data)}
      </div>
    );
  if (q.error) return <p className="error">Couldn't load: {q.error.message}</p>;
  return <Skeleton lines={4} />;
}

export function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "ok" | "warn";
}) {
  return (
    <div className={`panel kpi${tone ? ` admin-${tone}` : ""}`}>
      <span className="eyebrow">{label}</span>
      <span className="kpi-value num">{value}</span>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

export function Table({
  head,
  rows,
  empty = "Nothing yet.",
}: {
  head: string[];
  rows: ReactNode[][];
  empty?: string;
}) {
  if (rows.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const n = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString());
/** Dollars to the cent - AI spend is small numbers, which format.ts's usd() rounds away. */
export const dollars = (v: number | null | undefined) =>
  v === null || v === undefined ? "–" : `$${v.toFixed(2)}`;
export const ms = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "–"
    : v >= 60_000
      ? `${(v / 60_000).toFixed(1)}m`
      : v >= 1000
        ? `${(v / 1000).toFixed(1)}s`
        : `${Math.round(v)}ms`;
export const when = (iso: string | null | undefined) =>
  iso ? <span title={new Date(iso).toLocaleString()}>{ago(iso)}</span> : <span className="faint">never</span>;
export const Tag = ({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: ReactNode }) => (
  <span className={`admin-tag-${tone}`}>{children}</span>
);

export function Wallet({ address }: { address: string }) {
  return (
    <a
      className="num"
      href={`https://solscan.io/account/${address}`}
      target="_blank"
      rel="noreferrer"
      title={address}
    >
      {shortAddress(address)}
    </a>
  );
}
