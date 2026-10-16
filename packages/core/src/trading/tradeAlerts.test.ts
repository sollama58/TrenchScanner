import { describe, expect, it } from "vitest";
import {
  applyTradeAlertsPatch,
  DEFAULT_TRADE_ALERTS,
  parseTradeAlerts,
  saleEvent,
  tradeAlertsPatchSchema,
  tradeAlertWanted,
} from "./tradeAlerts.js";

describe("trade alert settings", () => {
  it("sends everything when nothing is stored, as before the setting existed", () => {
    expect(parseTradeAlerts(null)).toEqual(DEFAULT_TRADE_ALERTS);
    expect(Object.values(DEFAULT_TRADE_ALERTS.events).every(Boolean)).toBe(true);
  });

  it("reads field by field: a bad field is on, the rest are kept", () => {
    const parsed = parseTradeAlerts({ paper: false, bot: "yes", events: { stop_loss: false, buy: 3 } });
    expect(parsed.paper).toBe(false);
    expect(parsed.bot).toBe(true);
    expect(parsed.events.stop_loss).toBe(false);
    expect(parsed.events.buy).toBe(true);
  });

  it("merges a patch and refuses unknown or empty ones", () => {
    const next = applyTradeAlertsPatch(DEFAULT_TRADE_ALERTS, { events: { buy: false } });
    expect(next.events.buy).toBe(false);
    expect(next.events.take_profit).toBe(true);
    expect(next.paper).toBe(true);
    expect(tradeAlertsPatchSchema.safeParse({}).success).toBe(false);
    expect(tradeAlertsPatchSchema.safeParse({ events: { nope: true } }).success).toBe(false);
  });

  it("filters by source and event", () => {
    const s = applyTradeAlertsPatch(DEFAULT_TRADE_ALERTS, { paper: false, events: { time_limit: false } });
    expect(tradeAlertWanted(s, { source: "paper", event: "buy" })).toBe(false);
    expect(tradeAlertWanted(s, { source: "bot", event: "buy" })).toBe(true);
    expect(tradeAlertWanted(s, { source: "bot", event: saleEvent("trail_max_hold") })).toBe(false);
    expect(tradeAlertWanted(s, { source: "bot", event: saleEvent("take_profit") })).toBe(true);
  });
});
