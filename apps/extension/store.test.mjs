import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { storePolicyGaps } from "./storePolicy.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

describe("the store listing and privacy policy against the manifest (audit EX-2)", () => {
  it("justify every permission the manifest asks for", async () => {
    const manifest = JSON.parse(await read("./static/manifest.json"));
    const gaps = storePolicyGaps(
      manifest,
      await read("./STORE.md"),
      await read("../web/public/extension-privacy.html"),
    );
    expect(gaps).toEqual([]);
  });

  it("catch a permission neither names", () => {
    const manifest = { permissions: ["storage", "tabs"], host_permissions: ["https://*/*"] };
    const storeMd = "  - `storage`: keeps the key.";
    expect(storePolicyGaps(manifest, storeMd, "<p>Its permissions are storage.</p>")).toEqual([
      "STORE.md has no justification for tabs",
      "the privacy policy doesn't name tabs",
      "host_permissions is set, but STORE.md and the policy promise none",
    ]);
  });
});
