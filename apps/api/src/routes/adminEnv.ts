import type { FastifyInstance } from "fastify";
import {
  ENV_MANIFEST,
  envCommit,
  envReport,
  fetchJson,
  prisma,
  readEnvReport,
  type Env,
  type EnvNeed,
  type EnvService,
  type EnvState,
  type EnvVarReport,
} from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";
import { tokenSageMonitor } from "./adminUsage.js";

/** One variable on one service. "unknown": the service has not reported, or reported before the key existed. */
export interface EnvCell {
  need: EnvNeed | null;
  state: EnvState | "unknown";
  hint: string | null;
}

export interface EnvRow {
  key: string;
  group: string;
  kind: string;
  note: string | null;
  /** Meant to match across services, and the set ones don't (compared by fingerprint). */
  differs: boolean;
  cells: Record<string, EnvCell>;
}

export interface EnvColumn {
  id: string;
  label: string;
  /** When the report was written; the api's own column is read live. Null: never reported. */
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

const SERVICES: { id: EnvService; label: string }[] = [
  { id: "api", label: "api" },
  { id: "scanner", label: "scanner (worker)" },
  { id: "trainer", label: "trainer" },
];

/** Whether the set values of a `same` variable disagree: a secret or URL by fingerprint, a setting by value. */
function differs(reports: (EnvVarReport | undefined)[]): boolean {
  const seen = new Set<string>();
  for (const r of reports) {
    if (r?.state !== "set") continue;
    seen.add(r.print ?? r.hint ?? "");
  }
  return seen.size > 1;
}

/** TrenchScanner's own grid: the api live, every worker from its boot-time row. */
export async function trenchScannerEnv(env: NodeJS.ProcessEnv = process.env): Promise<EnvSystem> {
  const stored = await prisma.serviceEnvReport.findMany({ orderBy: { service: "asc" } });
  const reports = new Map<string, { vars: Record<string, EnvVarReport>; at: Date; commit: string | null }>();
  for (const row of stored) {
    reports.set(row.service, { vars: readEnvReport(row.vars), at: row.reportedAt, commit: row.commit });
  }
  reports.set("api", { vars: envReport(env), at: new Date(), commit: envCommit(env) });
  // The three Render services always, then any other process that reported (a trader, local "all").
  const columns: EnvColumn[] = [
    ...SERVICES.map((s) => ({ id: s.id as string, label: s.label })),
    ...stored
      .filter((r) => !SERVICES.some((s) => s.id === r.service))
      .map((r) => ({ id: r.service, label: r.service })),
  ].map((c) => {
    const r = reports.get(c.id);
    return {
      ...c,
      reportedAt: r ? r.at.toISOString() : null,
      commit: r?.commit ?? null,
      live: c.id === "api",
    };
  });
  const rows = ENV_MANIFEST.map((spec): EnvRow => {
    const cells: Record<string, EnvCell> = {};
    for (const c of columns) {
      const v = reports.get(c.id)?.vars[spec.key];
      cells[c.id] = {
        need: spec.on[c.id as EnvService] ?? null,
        state: v?.state ?? "unknown",
        hint: v?.hint ?? null,
      };
    }
    return {
      key: spec.key,
      group: spec.group,
      kind: spec.kind,
      note: spec.note ?? null,
      differs: spec.same === true && differs(columns.map((c) => reports.get(c.id)?.vars[spec.key])),
      cells,
    };
  });
  return { id: "trenchscanner", label: "TrenchScanner", status: "ok", error: null, columns, rows };
}

/** TokenSage's GET /admin/v1/env, as it answers (snake_case). */
interface TsEnv {
  services: { id: string; label: string; reported_at: string | null; commit: string | null; live: boolean }[];
  vars: {
    key: string;
    group: string;
    kind: string;
    note: string | null;
    differs: boolean;
    cells: Record<string, { need: EnvNeed | null; state: EnvState | "unknown"; hint: string | null }>;
  }[];
}

/** TokenSage's grid when it could not be read, saying why. */
function tokenSageDown(status: "unconfigured" | "error", error: string): EnvSystem {
  return { id: "tokensage", label: "TokenSage", status, error, columns: [], rows: [] };
}

/** TokenSage's own report of its api and analyzer, read with the monitor key. */
export async function tokenSageEnv(
  env: Pick<Env, "TOKENSAGE_API_URL" | "TOKENSAGE_MONITOR_KEY" | "TOKENSAGE_ADMIN_KEY">,
): Promise<EnvSystem> {
  const monitor = tokenSageMonitor(env);
  if (!monitor) {
    return tokenSageDown(
      "unconfigured",
      "TOKENSAGE_API_URL and TOKENSAGE_MONITOR_KEY are needed on the api to read TokenSage.",
    );
  }
  try {
    const ts = await fetchJson<TsEnv>(`${monitor.base}/admin/v1/env`, monitor.opts);
    return {
      id: "tokensage",
      label: "TokenSage",
      status: "ok",
      error: null,
      columns: ts.services.map((s) => ({
        id: s.id,
        label: s.label,
        reportedAt: s.reported_at,
        commit: s.commit,
        live: s.live,
      })),
      rows: ts.vars.map((v) => ({
        key: v.key,
        group: v.group,
        kind: v.kind,
        note: v.note,
        differs: v.differs,
        cells: v.cells,
      })),
    };
  } catch (err) {
    return tokenSageDown("error", String(err).slice(0, 200));
  }
}

/**
 * Admin > Environment: which expected env vars each service has set, never their values. Behind
 * authenticateAdmin (server.ts).
 */
export async function registerAdminEnvRoutes(app: FastifyInstance, opts: { env: Env }) {
  // TokenSage's answer for a minute: the page polls, and its report changes only on a deploy.
  const tokenSage = new SharedCache<EnvSystem>(60_000);
  app.get("/env", async () => {
    const [ours, theirs] = await Promise.all([
      trenchScannerEnv(),
      tokenSage.get(() => tokenSageEnv(opts.env)),
    ]);
    return { systems: [ours, theirs] };
  });
}
