import { describe, expect, it } from "vitest";
import { parseAuthChange } from "./authSync";
import { sessionEnded } from "./api";

describe("parseAuthChange", () => {
  it("reads another tab's sign-in and sign-out, and nothing else", () => {
    expect(parseAuthChange({ kind: "signed-out" })).toEqual({ kind: "signed-out" });
    expect(parseAuthChange({ kind: "signed-in", userId: "u1", at: 1 })).toEqual({
      kind: "signed-in",
      userId: "u1",
    });
    expect(parseAuthChange({ kind: "signed-in" })).toBeNull();
    expect(parseAuthChange({ kind: "other" })).toBeNull();
    expect(parseAuthChange(null)).toBeNull();
    expect(parseAuthChange("signed-out")).toBeNull();
  });
});

describe("sessionEnded", () => {
  it("is a 401 for a missing session outside the sign-in routes", () => {
    expect(sessionEnded("/settings", 401, { error: "unauthenticated" })).toBe(true);
    expect(sessionEnded("/matches?page=1", 401, { error: "unauthenticated" })).toBe(true);
  });

  it("isn't a sign-in step's 401, a wrong two-factor code, or another status", () => {
    // /auth/me answering 401 is the session check itself: App handles that one directly.
    expect(sessionEnded("/auth/me", 401, { error: "unauthenticated" })).toBe(false);
    expect(sessionEnded("/2fa/verify", 401, { error: "That code didn't match." })).toBe(false);
    expect(sessionEnded("/settings", 403, { error: "unauthenticated" })).toBe(false);
    expect(sessionEnded("/settings", 401, null)).toBe(false);
  });
});
