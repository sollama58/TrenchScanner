import { describe, expect, it, vi } from "vitest";
import {
  ALERT_CLEAR_GRACE_MS,
  CANDLE_SHARE_MIN_ANSWERS,
  ChartAlerts,
  ChartHealth,
  chartAlertProblems,
  STREAM_STALL_ALERT_MS,
} from "./chartHealth.js";

function clocked(start = 1_700_000_000_000) {
  let now = start;
  // The API process's Pump.fun gate counts, stubbed.
  const pump = { swapRequests: 0, swapThrottled: 0, swapHeldBack: 0 };
  const health = new ChartHealth(
    () => now,
    () => ({ ...pump }),
  );
  return { health, tick: (ms: number) => (now += ms), at: () => now, pump };
}

describe("ChartHealth", () => {
  it("counts candle answers by feed and source, and judges the null or stale share", () => {
    const { health } = clocked();
    for (let i = 0; i < 14; i++) health.recordCandleAnswer("chart", "pumpfun");
    for (let i = 0; i < 4; i++) health.recordCandleAnswer("fine", null);
    health.recordCandleAnswer("chart", "pumpfun", true);
    // Under CANDLE_SHARE_MIN_ANSWERS: not judged yet.
    expect(health.snapshot().candles.nullOrStaleShare).toBeNull();
    health.recordCandleAnswer("chart", "scan");
    const s = health.snapshot();
    expect(s.candles).toMatchObject({
      answers: CANDLE_SHARE_MIN_ANSWERS,
      null: 4,
      stale: 1,
      bySource: { "chart/pumpfun": 15, "chart/scan": 1 },
      nullOrStaleShare: 0.25,
    });
    expect(s.metrics.find((m) => m.key === "candlesNullOrStale")?.tone).toBe("warn");
    expect(s.status).toBe("warn");
  });

  it("counts answers short of the coin's history apart, amber from a share but never red", () => {
    const { health } = clocked();
    for (let i = 0; i < 12; i++) health.recordCandleAnswer("chart", "pumpfun");
    for (let i = 0; i < 8; i++) health.recordCandleAnswer("chart", "stream", false, true);
    const s = health.snapshot();
    expect(s.candles).toMatchObject({ answers: 20, partial: 8, null: 0, nullOrStaleShare: 0 });
    expect(s.metrics.find((m) => m.key === "candlesPartial")).toMatchObject({ window: 8, tone: "warn" });
    for (let i = 0; i < 80; i++) health.recordCandleAnswer("chart", "stream", false, true);
    expect(health.snapshot().metrics.find((m) => m.key === "candlesPartial")?.tone).toBe("warn");
    expect(chartAlertProblems(health.snapshot())).toEqual([]);
  });

  it("forgets counts older than the window, but keeps them since boot", () => {
    const { health, tick } = clocked();
    health.recordClientError("chart");
    tick(6 * 60_000);
    health.recordClientError("chart");
    const s = health.snapshot();
    expect(s.clientErrors).toEqual({ total: 1, byWhere: { chart: 1 } });
    expect(s.metrics.find((m) => m.key === "clientErrors")).toMatchObject({ window: 1, sinceBoot: 2 });
  });

  it("counts a stall once when it starts and reads red past STREAM_STALL_ALERT_MS", () => {
    const { health } = clocked();
    health.recordStreamStall(21_000);
    health.recordStreamStall(30_000);
    expect(health.snapshot().stream).toMatchObject({ stalls: 1, stalledForMs: 30_000 });
    health.recordStreamStall(STREAM_STALL_ALERT_MS);
    expect(health.snapshot().status).toBe("bad");
    health.recordStreamStall(0);
    health.recordStreamStall(25_000);
    expect(health.snapshot().stream.stalls).toBe(2);
  });

  it("folds the process's Pump.fun gate counts in", () => {
    const { health, pump } = clocked();
    Object.assign(pump, { swapRequests: 30, swapThrottled: 1, swapHeldBack: 12 });
    expect(health.snapshot().pumpFunGate).toEqual({ requests: 30, throttled: 1, heldBack: 12 });
    // Taken, not read: a second look adds only what is new.
    Object.assign(pump, { swapRequests: 5, swapThrottled: 0, swapHeldBack: 0 });
    expect(health.snapshot().pumpFunGate).toEqual({ requests: 35, throttled: 1, heldBack: 12 });
  });

  it("keeps a free-text label to a bounded set of names", () => {
    const { health } = clocked();
    for (let i = 0; i < 70; i++) health.recordClientError(`place-${i}<script>`);
    const by = health.snapshot().clientErrors.byWhere;
    expect(Object.keys(by)).toHaveLength(51);
    expect(by.other).toBe(20);
    expect(by["place-0script"]).toBe(1);
  });
});

describe("ChartAlerts", () => {
  it("tells the admins once when charts go blank, and once when they have stayed recovered", async () => {
    const { health, tick, at } = clocked();
    const sent: string[] = [];
    const alerts = new ChartAlerts(async (html) => void sent.push(html), at);
    for (let i = 0; i < 20; i++) health.recordCandleAnswer("fine", i < 8 ? null : "pumpfun");
    expect(chartAlertProblems(health.snapshot()).map((p) => p.key)).toEqual(["candles"]);
    await alerts.check(health.snapshot());
    await alerts.check(health.snapshot());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("40% of chart candle answers");
    // Checked every minute as it rolls out of the window: cleared only once it has stayed away
    // for the grace.
    let lastSeenAt = at();
    for (let i = 0; i < 10 && sent.length < 2; i++) {
      tick(60_000);
      if (chartAlertProblems(health.snapshot()).length > 0) lastSeenAt = at();
      await alerts.check(health.snapshot());
    }
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Charts recovered");
    expect(at() - lastSeenAt).toBeGreaterThanOrEqual(ALERT_CLEAR_GRACE_MS);
  });

  it("says nothing more when a problem flaps within the grace", async () => {
    const { health, tick, at } = clocked();
    const sent: string[] = [];
    const alerts = new ChartAlerts(async (html) => void sent.push(html), at);
    health.recordStreamStall(STREAM_STALL_ALERT_MS);
    await alerts.check(health.snapshot());
    health.recordStreamStall(0);
    tick(60_000);
    await alerts.check(health.snapshot());
    health.recordStreamStall(STREAM_STALL_ALERT_MS);
    tick(30_000);
    await alerts.check(health.snapshot());
    expect(sent).toHaveLength(1);
  });

  it("alerts on a chart socket stalled past two minutes, and survives a failed send", async () => {
    const { health, at } = clocked();
    const notify = vi.fn().mockRejectedValue(new Error("telegram down"));
    const alerts = new ChartAlerts(notify, at);
    health.recordStreamStall(STREAM_STALL_ALERT_MS + 1);
    await expect(alerts.check(health.snapshot())).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("chart socket has been silent");
  });
});
