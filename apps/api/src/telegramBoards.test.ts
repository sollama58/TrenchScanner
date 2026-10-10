import { describe, expect, it } from "vitest";
import { alertFor } from "./telegramBoards.js";

describe("alertFor", () => {
  const sentAt = new Date("2026-10-10T22:00:00Z");
  const at = (r: { at: Date }) => r.at;
  const row = (tokenId: string, minutesBefore: number) => ({
    tokenId,
    at: new Date(sentAt.getTime() - minutesBefore * 60_000),
  });

  it("picks the earliest alert on the token that the send could have carried", () => {
    const rows = [row("a", 1), row("a", 6), row("b", 3)];
    expect(alertFor(rows, at, "a", sentAt)).toBe(rows[1]);
  });

  it("passes over alerts too old to have been sent, or raised after the send", () => {
    const rows = [row("a", 60), row("a", -5)];
    expect(alertFor(rows, at, "a", sentAt)).toBeUndefined();
  });
});
