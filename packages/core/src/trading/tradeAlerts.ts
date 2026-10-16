import { z } from "zod";

/**
 * Which trade notes (tradeNotes.ts) reach an account's Telegram chats: one setting per account
 * (User.tradeAlerts), the same for its live bot and every paper strategy, on top of each bot's and
 * strategy's own "Telegram alerts" switch. Applied by the recipient at send time, so the server
 * bot's notes reach each admin as that admin's own settings say. Stored as JSON and read field by
 * field: anything missing or unreadable is on, as every note was before this setting existed.
 */

/** What a note is about: a buy, a sale by its exit reason, or a loss-limit stop. */
export const TRADE_ALERT_EVENTS = [
  "buy",
  "take_profit",
  "stop_loss",
  "trailing_stop",
  "time_limit",
  "manual",
  "loss_limit",
] as const;
export type TradeAlertEvent = (typeof TRADE_ALERT_EVENTS)[number];

/** Which bot a note is from. */
export type TradeAlertSource = "paper" | "bot";

export const tradeAlertsSchema = z.object({
  /** Notes from paper strategies. */
  paper: z.boolean(),
  /** Notes from the live trading bot (own and, for admins, the server wallet's). */
  bot: z.boolean(),
  /** Which kinds of note, for both. */
  events: z.object(
    Object.fromEntries(TRADE_ALERT_EVENTS.map((e) => [e, z.boolean()])) as Record<
      TradeAlertEvent,
      z.ZodBoolean
    >,
  ),
});
export type TradeAlerts = z.infer<typeof tradeAlertsSchema>;

export const DEFAULT_TRADE_ALERTS: TradeAlerts = {
  paper: true,
  bot: true,
  events: Object.fromEntries(TRADE_ALERT_EVENTS.map((e) => [e, true])) as Record<TradeAlertEvent, boolean>,
};

/** A partial update: either source, and any of the events. */
export const tradeAlertsPatchSchema = z
  .object({
    paper: z.boolean(),
    bot: z.boolean(),
    events: tradeAlertsSchema.shape.events.partial().strict(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "nothing to change");
export type TradeAlertsPatch = z.infer<typeof tradeAlertsPatchSchema>;

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The stored JSON as settings: a bad or missing field is on. */
export function parseTradeAlerts(stored: unknown): TradeAlerts {
  const raw = record(stored);
  const events = record(raw.events);
  return {
    paper: bool(raw.paper, DEFAULT_TRADE_ALERTS.paper),
    bot: bool(raw.bot, DEFAULT_TRADE_ALERTS.bot),
    events: Object.fromEntries(
      TRADE_ALERT_EVENTS.map((e) => [e, bool(events[e], DEFAULT_TRADE_ALERTS.events[e])]),
    ) as Record<TradeAlertEvent, boolean>,
  };
}

export function applyTradeAlertsPatch(current: TradeAlerts, patch: TradeAlertsPatch): TradeAlerts {
  return {
    paper: patch.paper ?? current.paper,
    bot: patch.bot ?? current.bot,
    events: { ...current.events, ...(patch.events ?? {}) },
  };
}

/** The event a sale is, by its exit reason; both time limits are one. */
export function saleEvent(reason: string): TradeAlertEvent {
  switch (reason) {
    case "take_profit":
    case "stop_loss":
    case "trailing_stop":
    case "manual":
      return reason;
    case "max_hold":
    case "trail_max_hold":
      return "time_limit";
    default:
      // A reason this doesn't know yet is a sale like any other: sent while stop losses are.
      return "stop_loss";
  }
}

/** Whether settings let a note through. */
export function tradeAlertWanted(
  alerts: TradeAlerts,
  note: { source: TradeAlertSource; event: TradeAlertEvent },
): boolean {
  return alerts[note.source] && alerts.events[note.event];
}
