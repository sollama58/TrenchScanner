import { describe, expect, it } from "vitest";
import type { Leaderboard } from "../api";
import { telegramBoard } from "./TelegramPanel";

const board = {
  entries: [{ id: "rules" }, { id: "linear" }, { id: "trees" }],
  defaultModel: "rules",
  defaultModels: ["trees", "linear"],
  selectedModels: ["rules"],
  followBest: false,
  followsDefault: false,
} as unknown as Leaderboard;

describe("telegramBoard", () => {
  it("checks Telegram's own picks, whatever the Live Feed has", () => {
    const tg = telegramBoard(board, { sameAsFeed: false, models: ["trees", "gone"] });
    expect(tg.selectedModels).toEqual(["trees"]);
    expect(tg.followBest).toBe(false);
  });

  it("shows the top models while Telegram has no picks left on the board", () => {
    for (const models of [[], ["gone"]]) {
      const tg = telegramBoard(board, { sameAsFeed: false, models });
      expect(tg.selectedModels).toEqual(["trees", "linear"]);
      expect(tg.followBest).toBe(true);
    }
  });
});
