import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import {
  aiReviewerState,
  cachedAiReviewerState,
  readAiReviewerSwitch,
  resetAiReviewerSwitchCache,
  setAiReviewerSwitch,
} from "./aiSwitch.js";

describe("AI reviewer switch", () => {
  beforeEach(async () => {
    await prisma.aiReviewerSwitch.deleteMany();
    resetAiReviewerSwitchCache();
  });
  afterAll(async () => {
    await prisma.aiReviewerSwitch.deleteMany();
    resetAiReviewerSwitchCache();
  });

  it("reads off with no row, and before the first read lands", async () => {
    expect(cachedAiReviewerState()).toBe("off");
    expect(await aiReviewerState()).toBe("off");
    expect(await readAiReviewerSwitch()).toEqual({ state: "off", updatedBy: null, updatedAt: null });
  });

  it("stores who changed it, and the change is read at once in this process", async () => {
    expect(await setAiReviewerSwitch("admins", "AdminWallet111")).toBe("admins");
    expect(await aiReviewerState()).toBe("admins");
    expect(cachedAiReviewerState()).toBe("admins");
    const row = await readAiReviewerSwitch();
    expect(row.state).toBe("admins");
    expect(row.updatedBy).toBe("AdminWallet111");
  });

  it("caches a read, and re-reads once the cache is stale", async () => {
    const t = Date.now();
    expect(await aiReviewerState(t)).toBe("off");
    await prisma.aiReviewerSwitch.create({ data: { id: "ai-reviewer", state: "live" } });
    expect(await aiReviewerState(t + 1_000)).toBe("off");
    expect(await aiReviewerState(t + 60_000)).toBe("live");
  });

  it("reads an unknown stored value as off", async () => {
    await prisma.aiReviewerSwitch.create({ data: { id: "ai-reviewer", state: "everyone" } });
    expect(await aiReviewerState()).toBe("off");
  });
});
