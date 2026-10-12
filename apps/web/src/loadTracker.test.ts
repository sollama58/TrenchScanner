import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginWait, loadState, markNavigation, resetLoadTracker } from "./loadTracker";

describe("loadTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLoadTracker();
  });
  afterEach(() => vi.useRealTimers());

  it("counts overlapping waits as one load and settles once they are all done", () => {
    const a = beginWait();
    const b = beginWait();
    expect(loadState()).toMatchObject({ active: true, total: 2, done: 0 });
    a();
    a(); // a second call is ignored
    expect(loadState()).toMatchObject({ active: true, done: 1 });
    b();
    expect(loadState().active).toBe(true);
    vi.advanceTimersByTime(200);
    expect(loadState().active).toBe(false);
  });

  it("keeps one load going when the next wait follows straight on", () => {
    beginWait()();
    vi.advanceTimersByTime(50);
    const next = beginWait();
    expect(loadState()).toMatchObject({ active: true, total: 2, done: 1 });
    next();
    vi.advanceTimersByTime(200);
    expect(loadState().active).toBe(false);
  });

  it("treats the first load and loads after a navigation as page loads", () => {
    beginWait()();
    expect(loadState().page).toBe(true);
    vi.advanceTimersByTime(200);

    vi.advanceTimersByTime(5_000);
    const later = beginWait();
    expect(loadState().page).toBe(false);
    // A navigation while a load runs makes it that page's load.
    markNavigation();
    expect(loadState().page).toBe(true);
    later();
  });
});
