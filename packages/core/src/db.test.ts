import { describe, expect, it } from "vitest";
import { appendPoolParams } from "./db.js";

/**
 * appendPoolParams is the mechanism behind DATABASE_CONNECTION_LIMIT/DATABASE_POOL_TIMEOUT_SECONDS
 * (see config/env.ts and render.yaml for why either is set) - the part that actually decides what
 * Prisma connects with.
 *
 * Verified end-to-end against a real pool too, outside this suite (module-load-time singleton
 * construction in db.ts makes that awkward to re-run per test case here): with
 * connection_limit=5, six concurrent 0.5s queries measurably queued (~1.05s total); with no
 * override, all six ran in parallel (~0.6s) - proof this isn't just a URL string Prisma ignores.
 * Import-safety with no DATABASE_URL set at all was verified the same way, against both this
 * code and the unmodified original, producing the identical PrismaClientInitializationError at
 * query time in both cases (never at import).
 */
describe("appendPoolParams", () => {
  const BASE = "postgresql://user:pass@host:5432/db";

  it("appends both params when neither is set", () => {
    const url = new URL(appendPoolParams(BASE, { connectionLimit: 12, poolTimeoutSeconds: 20 }));
    expect(url.searchParams.get("connection_limit")).toBe("12");
    expect(url.searchParams.get("pool_timeout")).toBe("20");
  });

  it("always sets pool_timeout, defaulting to 20s when not given", () => {
    const url = new URL(appendPoolParams(BASE, {}));
    expect(url.searchParams.get("pool_timeout")).toBe("20");
    // Left unset entirely, so Prisma falls back to its own CPU-derived default - the whole
    // point of leaving connectionLimit undefined rather than picking a fallback number here.
    expect(url.searchParams.has("connection_limit")).toBe(false);
  });

  it("sets a socket timeout and a shorter server statement timeout by default", () => {
    const url = new URL(appendPoolParams(BASE, {}));
    expect(url.searchParams.get("socket_timeout")).toBe("180");
    expect(url.searchParams.get("options")).toBe("-c statement_timeout=150000");
    const tuned = new URL(appendPoolParams(BASE, { socketTimeoutSeconds: 30, statementTimeoutSeconds: 20 }));
    expect(tuned.searchParams.get("socket_timeout")).toBe("30");
    expect(tuned.searchParams.get("options")).toBe("-c statement_timeout=20000");
  });

  it("never overrides a value the URL already specifies", () => {
    const url = new URL(
      appendPoolParams(`${BASE}?connection_limit=3&pool_timeout=5&socket_timeout=7&options=-c%20x%3D1`, {
        connectionLimit: 99,
        poolTimeoutSeconds: 99,
        socketTimeoutSeconds: 99,
        statementTimeoutSeconds: 99,
      }),
    );
    expect(url.searchParams.get("connection_limit")).toBe("3");
    expect(url.searchParams.get("pool_timeout")).toBe("5");
    expect(url.searchParams.get("socket_timeout")).toBe("7");
    expect(url.searchParams.get("options")).toBe("-c x=1");
  });

  it("preserves every other part of the URL untouched", () => {
    const withPath = "postgresql://user:pass@host:5432/db?sslmode=require";
    const url = new URL(appendPoolParams(withPath, { connectionLimit: 4 }));
    expect(url.origin).toBe(new URL(withPath).origin);
    expect(url.pathname).toBe("/db");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("connection_limit")).toBe("4");
  });

  it("throws on a malformed URL - the caller is responsible for falling back safely", () => {
    // db.ts's tunedDatasourceUrl() catches this and returns null rather than letting a bad
    // DATABASE_URL crash module import; this function itself does not swallow the error, so
    // that fallback is visible to whoever calls it rather than silently producing garbage.
    expect(() => appendPoolParams("not a url", {})).toThrow();
  });
});
