import { describe, expect, it } from "vitest";
import { notifyCuratedAlert, notifyMatchesCreated, onAlertWritten } from "./notify.js";

describe("onAlertWritten", () => {
  it("hears every alert this process announces, and stops when unsubscribed", async () => {
    let heard = 0;
    const off = onAlertWritten(() => (heard += 1));
    const broken = onAlertWritten(() => {
      throw new Error("a bad listener costs nothing");
    });
    await notifyCuratedAlert({ alertId: "a" });
    await notifyMatchesCreated([{ userId: "u", matchId: "m" }]);
    await notifyMatchesCreated([]);
    expect(heard).toBe(2);
    off();
    broken();
    await notifyCuratedAlert({ alertId: "b" });
    expect(heard).toBe(2);
  });
});
