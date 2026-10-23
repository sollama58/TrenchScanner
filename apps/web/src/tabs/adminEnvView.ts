/** Admin > Environment's reading of GET /admin/env (apps/api/src/routes/adminEnv.ts). */

export type EnvNeed = "required" | "expected" | "optional";
export type EnvCellState = "set" | "empty" | "missing" | "unknown";

export interface EnvCell {
  need: EnvNeed | null;
  state: EnvCellState;
  hint: string | null;
}

export interface EnvRow {
  key: string;
  group: string;
  kind: string;
  note: string | null;
  differs: boolean;
  cells: Record<string, EnvCell>;
}

export interface EnvColumn {
  id: string;
  label: string;
  reportedAt: string | null;
  commit: string | null;
  live: boolean;
}

export interface EnvSystem {
  id: "trenchscanner" | "tokensage";
  label: string;
  status: "ok" | "unconfigured" | "error";
  error: string | null;
  columns: EnvColumn[];
  rows: EnvRow[];
}

export interface EnvReport {
  systems: EnvSystem[];
}

/** A cell that needs fixing: a required or expected variable that is missing or blank. */
export function cellProblem(c: EnvCell | undefined): boolean {
  return (
    !!c && (c.need === "required" || c.need === "expected") && (c.state === "missing" || c.state === "empty")
  );
}

/** A row worth a look: a cell that needs fixing, or a shared value that differs between services. */
export function rowProblem(r: EnvRow): boolean {
  return r.differs || Object.values(r.cells).some(cellProblem);
}

/** Every problem in a system as one plain line each, required ones first. */
export function problemLines(s: EnvSystem): { text: string; severity: "bad" | "warn" }[] {
  const out: { text: string; severity: "bad" | "warn" }[] = [];
  const label = (id: string) => s.columns.find((c) => c.id === id)?.label ?? id;
  for (const c of s.columns) {
    if (!c.live && c.reportedAt === null)
      out.push({ text: `${c.label} has not reported yet`, severity: "warn" });
  }
  for (const r of s.rows) {
    for (const [id, c] of Object.entries(r.cells)) {
      if (!cellProblem(c)) continue;
      out.push({
        text: `${r.key} is ${c.state === "empty" ? "blank" : "missing"} on ${label(id)}`,
        severity: c.need === "required" ? "bad" : "warn",
      });
    }
    if (r.differs) out.push({ text: `${r.key} differs between services`, severity: "warn" });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "bad" ? -1 : 1));
}

/** Rows split by their group, in the order the API sent them. */
export function groupRows(rows: EnvRow[]): { group: string; rows: EnvRow[] }[] {
  const out: { group: string; rows: EnvRow[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.group === r.group) last.rows.push(r);
    else out.push({ group: r.group, rows: [r] });
  }
  return out;
}
