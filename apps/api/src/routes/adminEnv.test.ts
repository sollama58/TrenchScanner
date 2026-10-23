// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { envReport, prisma, publishEnvReport } from "@trenchscanner/core";
import { tokenSageEnv, trenchScannerEnv } from "./adminEnv.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const ROLES = ["scanner", "trainer", "test-env-extra"];

async function cleanup() {
  await prisma.serviceEnvReport.deleteMany({ where: { service: { in: ROLES } } });
}

afterAll(async () => {
  if (dbAvailable) await cleanup();
});

describe.skipIf(!dbAvailable)("trenchScannerEnv", () => {
  it("lays the api's live env beside each worker's stored report, never a secret's value", async () => {
    await cleanup();
    await publishEnvReport("scanner", {
      HELIUS_API_KEY: "helius-secret-aaaa",
      LIVE_TAPE_PAGES_PER_CYCLE: "8",
      COINGECKO_API_KEY: "cg-one",
      RENDER_GIT_COMMIT: "abcdef1234567890",
    });
    // An older trainer's row without COINGECKO_API_KEY in it at all.
    const trainerVars = envReport({ COINGECKO_API_KEY: "cg-two" });
    delete (trainerVars as Record<string, unknown>).TOKENSAGE_XREUSE_RESTORED_AT;
    await prisma.serviceEnvReport.create({
      data: { service: "trainer", vars: trainerVars as object, reportedAt: new Date() },
    });

    const sys = await trenchScannerEnv({ HELIUS_API_KEY: "helius-secret-aaaa", COINGECKO_API_KEY: "" });
    expect(sys.columns.map((c) => c.id).slice(0, 3)).toEqual(["api", "scanner", "trainer"]);
    expect(sys.columns[0]!.live).toBe(true);
    expect(sys.columns[1]!.commit).toBe("abcdef123456");

    const row = (key: string) => sys.rows.find((r) => r.key === key)!;
    expect(row("HELIUS_API_KEY").cells.api).toEqual({ need: "required", state: "set", hint: "18 chars" });
    expect(row("HELIUS_API_KEY").cells.trainer!.need).toBeNull();
    expect(row("HELIUS_API_KEY").differs).toBe(false);
    expect(row("LIVE_TAPE_PAGES_PER_CYCLE").cells.scanner).toEqual({
      need: "expected",
      state: "set",
      hint: "8",
    });
    expect(row("COINGECKO_API_KEY").cells.api!.state).toBe("empty");
    // Set on both workers, to different keys.
    expect(row("COINGECKO_API_KEY").differs).toBe(true);
    expect(row("TOKENSAGE_XREUSE_RESTORED_AT").cells.trainer!.state).toBe("unknown");
    expect(JSON.stringify(sys)).not.toContain("helius-secret");
    expect(JSON.stringify(sys)).not.toContain("cg-one");
  });

  it("adds a column for any other process that reported", async () => {
    await publishEnvReport("test-env-extra", {});
    const sys = await trenchScannerEnv({});
    const extra = sys.columns.find((c) => c.id === "test-env-extra");
    expect(extra?.reportedAt).not.toBeNull();
    expect(sys.rows[0]!.cells["test-env-extra"]!.need).toBeNull();
  });
});

describe("tokenSageEnv", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says what is missing when TokenSage can't be read", async () => {
    const none = await tokenSageEnv({
      TOKENSAGE_API_URL: "",
      TOKENSAGE_MONITOR_KEY: "",
      TOKENSAGE_ADMIN_KEY: "",
    });
    expect(none.status).toBe("unconfigured");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const err = await tokenSageEnv({
      TOKENSAGE_API_URL: "https://ts.example",
      TOKENSAGE_MONITOR_KEY: "m",
      TOKENSAGE_ADMIN_KEY: "",
    });
    expect(err.status).toBe("error");
  });

  it("maps TokenSage's report onto the grid", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            services: [
              {
                id: "analyzer",
                label: "tokensage-analyzer",
                reported_at: "2026-10-23T10:00:00Z",
                commit: "abc",
                live: false,
              },
            ],
            vars: [
              {
                key: "TRUSTED_HINT_KEYS",
                group: "Auth",
                kind: "setting",
                note: null,
                differs: false,
                cells: { analyzer: { need: "expected", state: "missing", hint: null } },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sys = await tokenSageEnv({
      TOKENSAGE_API_URL: "https://ts.example/",
      TOKENSAGE_MONITOR_KEY: "m",
      TOKENSAGE_ADMIN_KEY: "",
    });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://ts.example/admin/v1/env");
    expect(sys.status).toBe("ok");
    expect(sys.columns[0]).toEqual({
      id: "analyzer",
      label: "tokensage-analyzer",
      reportedAt: "2026-10-23T10:00:00Z",
      commit: "abc",
      live: false,
    });
    expect(sys.rows[0]!.cells.analyzer!.state).toBe("missing");
  });
});
