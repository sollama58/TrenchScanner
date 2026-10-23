import { describe, expect, it } from "vitest";
import {
  cellProblem,
  groupRows,
  problemLines,
  rowProblem,
  type EnvRow,
  type EnvSystem,
} from "./adminEnvView";

const row = (key: string, cells: EnvRow["cells"], extra: Partial<EnvRow> = {}): EnvRow => ({
  key,
  group: "Core",
  kind: "secret",
  note: null,
  differs: false,
  cells,
  ...extra,
});

describe("adminEnvView", () => {
  it("counts only required or expected variables that are missing or blank", () => {
    expect(cellProblem({ need: "required", state: "missing", hint: null })).toBe(true);
    expect(cellProblem({ need: "expected", state: "empty", hint: null })).toBe(true);
    expect(cellProblem({ need: "optional", state: "missing", hint: null })).toBe(false);
    expect(cellProblem({ need: null, state: "missing", hint: null })).toBe(false);
    expect(cellProblem({ need: "required", state: "unknown", hint: null })).toBe(false);
    expect(rowProblem(row("A", {}, { differs: true }))).toBe(true);
  });

  it("lists problems with required ones first, and services that never reported", () => {
    const s: EnvSystem = {
      id: "trenchscanner",
      label: "TrenchScanner",
      status: "ok",
      error: null,
      columns: [
        { id: "api", label: "api", reportedAt: "x", commit: null, live: true },
        { id: "trainer", label: "trainer", reportedAt: null, commit: null, live: false },
      ],
      rows: [
        row("COINGECKO_API_KEY", { api: { need: "expected", state: "missing", hint: null } }),
        row("HELIUS_API_KEY", { api: { need: "required", state: "empty", hint: null } }, { differs: true }),
      ],
    };
    expect(problemLines(s).map((p) => p.text)).toEqual([
      "HELIUS_API_KEY is blank on api",
      "trainer has not reported yet",
      "COINGECKO_API_KEY is missing on api",
      "HELIUS_API_KEY differs between services",
    ]);
  });

  it("groups consecutive rows", () => {
    const g = groupRows([row("A", {}), row("B", {}, { group: "AI" }), row("C", {}, { group: "AI" })]);
    expect(g.map((x) => [x.group, x.rows.length])).toEqual([
      ["Core", 1],
      ["AI", 2],
    ]);
  });
});
