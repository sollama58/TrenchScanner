import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SAME_SITE_APIS } from "./api";

/**
 * The dashboard's Content-Security-Policy (render.yaml, trenchscanner-web `headers:`) allows the
 * inline <script>s of index.html and tokensage/index.html by their sha256. Editing one of them, or
 * the VITE_API_URL that Vite bakes into the boot prefetch, changes the hash, and the browser would
 * then silently refuse to run it in production. These tests hash the scripts exactly as the build
 * writes them and check the header lists each one.
 */

const WEB = resolve(import.meta.dirname, "..");
const renderYaml = readFileSync(resolve(WEB, "../../render.yaml"), "utf8");

/** The trenchscanner-web service's block of render.yaml (up to the next top-level key). */
function webService(): string {
  const start = renderYaml.indexOf("name: trenchscanner-web");
  expect(start).toBeGreaterThan(-1);
  const end = renderYaml.indexOf("\ndatabases:", start);
  return renderYaml.slice(start, end === -1 ? undefined : end);
}

function webCsp(): Map<string, string[]> {
  const m = /name: Content-Security-Policy\s*\n\s*value: "([^"]+)"/.exec(webService());
  expect(m, "trenchscanner-web has a Content-Security-Policy header").not.toBeNull();
  const csp = new Map<string, string[]>();
  for (const directive of (m?.[1] ?? "").split(";")) {
    const [name, ...values] = directive.trim().split(/\s+/);
    if (name) csp.set(name, values);
  }
  return csp;
}

function viteApiUrl(): string {
  const m = /key: VITE_API_URL\s*\n\s*value: (\S+)/.exec(webService());
  expect(m, "trenchscanner-web sets VITE_API_URL").not.toBeNull();
  return m?.[1] ?? "";
}

/** Hashes of each inline script in `file`, after Vite's %VITE_API_URL% replacement. */
function inlineScriptHashes(file: string): string[] {
  const html = readFileSync(resolve(WEB, file), "utf8").replaceAll("%VITE_API_URL%", viteApiUrl());
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) =>
      `'sha256-${createHash("sha256")
        .update(m[1] ?? "", "utf8")
        .digest("base64")}'`,
  );
}

describe("dashboard Content-Security-Policy", () => {
  it("allows every inline script of both pages by hash", () => {
    const scriptSrc = webCsp().get("script-src") ?? [];
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    const hashes = [...inlineScriptHashes("index.html"), ...inlineScriptHashes("tokensage/index.html")];
    expect(hashes.length).toBeGreaterThan(0);
    for (const h of hashes) expect(scriptSrc, `render.yaml script-src is missing ${h}`).toContain(h);
    // No stale hashes left behind either.
    expect(scriptSrc.filter((s) => s.startsWith("'sha256-")).sort()).toEqual([...new Set(hashes)].sort());
  });

  it("lets the app reach its API on every host", () => {
    const connectSrc = webCsp().get("connect-src") ?? [];
    expect(connectSrc).toContain(new URL(viteApiUrl()).origin);
    for (const url of Object.values(SAME_SITE_APIS)) expect(connectSrc).toContain(new URL(url).origin);
  });

  it("lets Privy's email sign-in run, and nothing else from outside", () => {
    const csp = webCsp();
    const connectSrc = csp.get("connect-src") ?? [];
    for (const host of ["https://auth.privy.io", "https://*.rpc.privy.systems"])
      expect(connectSrc).toContain(host);
    expect(csp.get("frame-src")).toContain("https://auth.privy.io");
    // The only outside script: Privy's captcha (Cloudflare Turnstile).
    const scripts = (csp.get("script-src") ?? []).filter((s) => !s.startsWith("'sha256-"));
    expect(scripts.sort()).toEqual(["'self'", "https://challenges.cloudflare.com"]);
  });

  it("keeps the HolDEX frame allowance and the lockdown directives", () => {
    const csp = webCsp();
    expect(csp.get("frame-ancestors")).toEqual(["'self'", "https://holdex.live", "https://www.holdex.live"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
  });
});
