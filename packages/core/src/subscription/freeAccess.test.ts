import { describe, expect, it } from "vitest";
import {
  freeAccessCleanupAt,
  freeAccessPhase,
  freeAccessTimesProblem,
  keepReason,
  type RetentionFacts,
} from "./freeAccess.js";

const H = 3_600_000;
const now = new Date("2026-10-16T12:00:00Z");
const at = (hours: number) => new Date(now.getTime() + hours * H);

describe("freeAccessPhase", () => {
  const period = {
    signInStartsAt: at(1),
    signInEndsAt: at(2),
    accessEndsAt: at(3),
    disabledAt: null,
    purgedAt: null,
  };

  it("walks scheduled, open, running, ended as the clock passes each time", () => {
    expect(freeAccessPhase(period, at(0))).toBe("scheduled");
    expect(freeAccessPhase(period, at(1))).toBe("open");
    expect(freeAccessPhase(period, at(2))).toBe("running");
    expect(freeAccessPhase(period, at(3))).toBe("ended");
  });

  it("is ended at once when switched off or cleaned up, whatever the times say", () => {
    expect(freeAccessPhase({ ...period, disabledAt: at(1.5) }, at(1.5))).toBe("ended");
    expect(freeAccessPhase({ ...period, purgedAt: at(0) }, at(0))).toBe("ended");
  });
});

describe("freeAccessTimesProblem", () => {
  const ok = { signInStartsAt: at(-1), signInEndsAt: at(1), accessEndsAt: at(1) };

  it("takes access ending the moment sign-in closes", () => {
    expect(freeAccessTimesProblem(ok, now)).toBeNull();
  });

  it("refuses times out of order, already over, or longer than the cap", () => {
    expect(freeAccessTimesProblem({ ...ok, signInEndsAt: ok.signInStartsAt }, now)).toMatch(/close after/);
    expect(freeAccessTimesProblem({ ...ok, accessEndsAt: at(0.5) }, now)).toMatch(/before sign-in closes/);
    expect(
      freeAccessTimesProblem({ signInStartsAt: at(-3), signInEndsAt: at(-2), accessEndsAt: at(-1) }, now),
    ).toMatch(/future/);
    expect(freeAccessTimesProblem({ ...ok, accessEndsAt: at(91 * 24) }, now)).toMatch(/at most 90 days/);
  });
});

describe("keepReason", () => {
  const free: RetentionFacts = {
    createdAccount: true,
    isAdmin: false,
    accountExists: true,
    subscriptionExpiresAt: null,
    whitelisted: false,
    burned: false,
    burnCredits: false,
    trading: false,
  };

  it("deletes only an account the period created that nothing else holds on to", () => {
    expect(keepReason(free, now)).toBeNull();
  });

  it("keeps every account any retention rule covers", () => {
    expect(keepReason({ ...free, createdAccount: false }, now)).toBe("account existed before free access");
    expect(keepReason({ ...free, accountExists: false }, now)).toBe("account already gone");
    expect(keepReason({ ...free, isAdmin: true }, now)).toBe("admin wallet");
    expect(keepReason({ ...free, subscriptionExpiresAt: at(1) }, now)).toBe("subscriber");
    expect(keepReason({ ...free, subscriptionExpiresAt: at(-1) }, now)).toBe("has a subscription record");
    expect(keepReason({ ...free, whitelisted: true }, now)).toBe("whitelisted");
    expect(keepReason({ ...free, burned: true }, now)).toBe("burned $ASDFASDFA");
    expect(keepReason({ ...free, burnCredits: true }, now)).toBe("has Burn Credits history");
    expect(keepReason({ ...free, trading: true }, now)).toBe("has a trading wallet or trades");
  });
});

describe("freeAccessCleanupAt", () => {
  it("waits an hour past the end, whichever came first: the expiry or the switch-off", () => {
    expect(freeAccessCleanupAt({ accessEndsAt: at(3), disabledAt: null })).toEqual(at(4));
    expect(freeAccessCleanupAt({ accessEndsAt: at(3), disabledAt: at(1) })).toEqual(at(2));
  });
});
