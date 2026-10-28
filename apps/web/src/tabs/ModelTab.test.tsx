import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Leaderboard } from "../api";
import { ScoreFigs } from "./ModelTab";

describe("ScoreFigs", () => {
  it("names 90 as the score where On target starts, not a count of models", () => {
    // "ON TARGET 90" beside "SEASONED MODELS 27 of 29" read as 90 models on target (audit 10-27 WB-28).
    const board = {
      entries: [
        { composite: { score: 33, warmingUp: false } },
        { composite: { score: null, warmingUp: true } },
      ],
    } as unknown as Leaderboard;
    const html = renderToStaticMarkup(<ScoreFigs board={board} />);
    expect(html).toContain("<label>On target from</label>");
    expect(html).not.toContain("<label>On target</label>");
    expect(html).toContain("1 of 2");
  });
});
