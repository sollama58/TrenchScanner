import { describe, expect, it } from "vitest";
import { SectionBoundary } from "./SectionBoundary";

describe("SectionBoundary", () => {
  const error = new Error("boom");

  it("keeps the error while the reset key stays the same", () => {
    expect(
      SectionBoundary.getDerivedStateFromProps(
        { label: "x", children: null, resetKey: "a" },
        { error, resetKey: "a" },
      ),
    ).toBeNull();
  });

  it("clears the error when the reset key changes (another card, tab or token)", () => {
    expect(
      SectionBoundary.getDerivedStateFromProps(
        { label: "x", children: null, resetKey: "b" },
        { error, resetKey: "a" },
      ),
    ).toEqual({ error: null, resetKey: "b" });
  });

  it("catches a render error into state", () => {
    expect(SectionBoundary.getDerivedStateFromError(error)).toEqual({ error });
  });
});
