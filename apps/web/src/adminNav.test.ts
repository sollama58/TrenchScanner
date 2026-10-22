import { describe, expect, it } from "vitest";
import { adminHashFor, adminSectionFromHash, isAdminHash } from "./adminNav";

describe("admin hash", () => {
  it("keeps the admin tab for a section hash and the old trading link", () => {
    expect(isAdminHash("#admin")).toBe(true);
    expect(isAdminHash("#admin/models")).toBe(true);
    expect(isAdminHash("#trading")).toBe(true);
    expect(isAdminHash("#model")).toBe(false);
    expect(isAdminHash("")).toBe(false);
  });

  it("opens Models + Training from the models hash and the old training hash", () => {
    expect(adminSectionFromHash("#admin/models")).toBe("models");
    expect(adminSectionFromHash("#admin/training")).toBe("models");
    expect(adminSectionFromHash("#trading")).toBe("bot");
    expect(adminSectionFromHash("#admin")).toBe("overview");
    expect(adminSectionFromHash("#admin/nope")).toBe("overview");
  });

  it("writes a hash the parser reads back", () => {
    expect(adminSectionFromHash(adminHashFor("usage"))).toBe("usage");
    expect(adminHashFor("overview")).toBe("#admin");
  });
});
