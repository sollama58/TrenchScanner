import { describe, expect, it } from "vitest";
import { bucketLabel, delta, explorerPath, seconds } from "./adminModelsExplorerView";

describe("explorerPath", () => {
  it("asks for a preset or a range, and a seat when picked", () => {
    expect(explorerPath({ kind: "preset", minutes: 60 }, null)).toBe("/admin/models/performance?minutes=60");
    expect(
      explorerPath(
        { kind: "range", since: "2026-10-26T00:00:00.000Z", until: "2026-10-26T06:00:00.000Z" },
        "trees",
      ),
    ).toBe(
      "/admin/models/performance?since=2026-10-26T00%3A00%3A00.000Z&until=2026-10-26T06%3A00%3A00.000Z&model=trees",
    );
  });
});

describe("bucketLabel", () => {
  it("shows the date only for windows past a day", () => {
    expect(bucketLabel("2026-10-26T13:05:00Z", 60, "UTC")).toBe("13:05");
    expect(bucketLabel("2026-10-26T13:05:00Z", 4320, "UTC")).toMatch(/Oct 26.*13:05/);
    expect(bucketLabel("", 60)).toBe("");
  });
});

describe("seconds", () => {
  it("reads as seconds, then minutes", () => {
    expect(seconds(null)).toBe("–");
    expect(seconds(45)).toBe("45s");
    expect(seconds(90)).toBe("1m 30s");
    expect(seconds(120)).toBe("2m");
  });
});

describe("delta", () => {
  it("states the change from the prior span in the figure's own unit", () => {
    expect(delta(24.5, 22, "pts")).toBe("+2.5 pts");
    expect(delta(20, 22, "pts")).toBe("-2.0 pts");
    expect(delta(110, 100, "%")).toBe("+10%");
    expect(delta(5, 0, "%")).toBe("new");
    expect(delta(1.3, 1.25, "x")).toBe("+0.05");
    expect(delta(1, null, "pts")).toBe("no prior");
    expect(delta(22, 22, "pts")).toBe("±0 pts");
  });
});
