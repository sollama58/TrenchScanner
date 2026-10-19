import type { InlineKeyboard } from "./api.js";
import {
  DEFAULT_STYLE,
  DIVIDER,
  alertLinkUrl,
  escapeHtml,
  shortUsd,
  usd,
  type AlertLinks,
  type AlertStyle,
} from "./format.js";

/**
 * The bot's two read-back commands: /alerts (the alerts this chat got that are still being
 * tracked, with how each is doing now) and /trenchboard (how the chat's alerts did over a window,
 * picked with buttons under the message). Only the text lives here; the numbers come from the
 * API, which grades each alert exactly as the dashboard's Live tab does (TelegramBoards).
 */

/** How one alert stands, in the dashboard's own words (curatedFeed.ts OutcomeView.status). */
export type BoardOutcomeStatus = "watching" | "won" | "missed" | "disqualified" | "unknown";

/** One alert this chat received that is still being tracked. */
export interface ActiveAlert {
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  /** When the chat got it. */
  sentAt: Date;
  /** What raised it: the model's name for a call, the filter's for a filter match. */
  source: { kind: "model" | "filter"; name: string };
  /** The market cap at the alert, the base the returns below are on. */
  alertMcapUsd: number | null;
  /** The market cap now (the live reading, else the newest snapshot). */
  nowMcapUsd: number | null;
  /** The card's Peak: the highest it went above the alert price, in percent. */
  peakPct: number | null;
  status: BoardOutcomeStatus;
  /** A 2x seen inside the win window, before the verdict lands. */
  hit2x: boolean;
  /** Minutes left in the 15-minute win window; null once it has closed. */
  minutesLeft: number | null;
}

/** How the chat's alerts over one window did. */
export interface BoardStats {
  hours: number;
  alerts: number;
  /** Alerts whose 15-minute win window closed with a verdict. */
  graded: number;
  /** Clean 2x inside the window ("won"); a stopped-out 2x is a loss, as on the dashboard. */
  won: number;
  lost: number;
  /** Still inside their window. */
  pending: number;
  /** Alerts whose exit-plan return has landed, and their average return, in percent. */
  settled: number;
  avgReturnPct: number | null;
  /** The alert that ran furthest, by its Peak. */
  best: { symbol: string | null; mintAddress: string; peakPct: number } | null;
  /**
   * When this chat's record starts, if after the window's start: the bot keeps the list of what
   * each chat got from 2026-10-10 on, and a chat linked later has nothing before its link.
   */
  recordedSince: Date | null;
}

/** What the API hands the bot: the reads behind the two commands, for one linked chat. */
export interface TelegramBoards {
  /** `chatId` is the TelegramChat row's id. */
  activeAlerts(chatId: string): Promise<ActiveAlert[]>;
  board(chatId: string, hours: number): Promise<BoardStats>;
}

export const BOARD_WINDOWS = [
  { key: "3h", hours: 3 },
  { key: "6h", hours: 6 },
  { key: "12h", hours: 12 },
  { key: "24h", hours: 24 },
  { key: "7d", hours: 168 },
] as const;
export type BoardWindowKey = (typeof BOARD_WINDOWS)[number]["key"];
export const DEFAULT_BOARD_WINDOW: BoardWindowKey = "24h";

/** "24h", "24", "1d", "7d", "week" -> the window; null for anything else. */
export function boardWindow(text: string): (typeof BOARD_WINDOWS)[number] | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const alias: Record<string, BoardWindowKey> = {
    "1d": "24h",
    day: "24h",
    "168h": "7d",
    week: "7d",
    "1w": "7d",
  };
  const key = alias[t] ?? (/^\d+$/.test(t) ? `${t}h` : t);
  return BOARD_WINDOWS.find((w) => w.key === key) ?? null;
}

/** Button presses: "tb:<window>" for the trenchboard, "al" to refresh /alerts. */
export const BOARD_CALLBACK_PREFIX = "tb:";
export const ALERTS_REFRESH_CALLBACK = "al";

/** The window buttons, the shown one marked. Pressing it again refreshes the numbers. */
export function trenchboardKeyboard(selected: BoardWindowKey): InlineKeyboard {
  return {
    inline_keyboard: [
      BOARD_WINDOWS.map((w) => ({
        text: w.key === selected ? `• ${w.key} •` : w.key,
        callback_data: `${BOARD_CALLBACK_PREFIX}${w.key}`,
      })),
    ],
  };
}

export const ALERTS_KEYBOARD: InlineKeyboard = {
  inline_keyboard: [[{ text: "🔄 Refresh", callback_data: ALERTS_REFRESH_CALLBACK }]],
};

/** /alerts lists this many, newest first, and counts the rest. */
export const ACTIVE_ALERTS_MAX = 15;

/** +45%, −12%, +1,240%. */
export function signedPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "–";
  const r = Math.round(pct);
  if (r === 0) return "0%";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toLocaleString("en-US")}%`;
}

function label(a: { symbol: string | null; name?: string | null; mintAddress: string }): string {
  if (a.symbol) return `$${a.symbol}`;
  if (a.name) return a.name;
  return `${a.mintAddress.slice(0, 4)}…${a.mintAddress.slice(-4)}`;
}

function agoText(at: Date, now: number): string {
  const mins = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The alert's standing, as its feed card shows it. */
export function statusText(a: Pick<ActiveAlert, "status" | "hit2x" | "minutesLeft">): string {
  switch (a.status) {
    case "watching":
      if (a.hit2x) return "🚀 2x hit";
      return a.minutesLeft !== null ? `⏳ ${a.minutesLeft}m left` : "⏳ live";
    case "won":
      return "✅ 2x";
    case "missed":
      return "❌ no 2x";
    case "disqualified":
      return "🛑 stopped out";
    default:
      return "· ungraded";
  }
}

/** Current return on the alert's market cap; null without both readings. */
export function currentReturnPct(a: Pick<ActiveAlert, "alertMcapUsd" | "nowMcapUsd">): number | null {
  if (a.alertMcapUsd === null || a.nowMcapUsd === null || !(a.alertMcapUsd > 0)) return null;
  const pct = (a.nowMcapUsd / a.alertMcapUsd - 1) * 100;
  return Number.isFinite(pct) ? pct : null;
}

function dashboardLink(links: AlertLinks, text: string): string | null {
  const base = links.dashboardUrl.replace(/\/$/, "");
  return base ? `<a href="${escapeHtml(base)}/#live">${text}</a>` : null;
}

/** The /alerts answer: each tracked alert, newest first, with its return now and its Peak. */
export function formatActiveAlerts(
  all: readonly ActiveAlert[],
  links: AlertLinks,
  now = Date.now(),
  opts: { minMcapUsd?: number; style?: AlertStyle } = {},
): string {
  const floor = opts.minMcapUsd ?? 0;
  const style = opts.style ?? DEFAULT_STYLE;
  // Judged on the market cap now, else at the alert when there is no reading since.
  const alerts = all.filter((a) => floor <= 0 || (a.nowMcapUsd ?? a.alertMcapUsd ?? 0) >= floor);
  const under = all.length - alerts.length;
  const floorNote =
    under > 0 ? `<i>${under} under ${shortUsd(floor)} market cap not shown; /mincap changes that.</i>` : null;
  if (alerts.length === 0) {
    return [
      "📡 <b>Active alerts</b>",
      DIVIDER,
      "Nothing this chat was alerted on is being tracked right now.",
      ...(floorNote ? ["", floorNote] : []),
      "",
      "See how the past ones did with /trenchboard.",
    ].join("\n");
  }
  const sorted = [...alerts].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  const lines = [`📡 <b>Active alerts</b>  ·  ${alerts.length} tracking`, DIVIDER];
  const first = style.links[0];
  sorted.slice(0, ACTIVE_ALERTS_MAX).forEach((a, i) => {
    const icon = a.source.kind === "model" ? "🟢" : "🎯";
    const head =
      `<b>${i + 1}.</b> ${icon} <b>${escapeHtml(label(a))}</b>  ·  ${agoText(a.sentAt, now)}  ·  ` +
      statusText(a);
    const ret = currentReturnPct(a);
    const facts = [
      `Now <b>${signedPct(ret)}</b>`,
      a.nowMcapUsd !== null ? `MC ${usd(a.nowMcapUsd)}` : null,
      a.peakPct !== null ? `Peak ${signedPct(a.peakPct)}` : null,
      first ? `<a href="${escapeHtml(alertLinkUrl(first, a.mintAddress))}">trade ↗</a>` : null,
    ].filter(Boolean);
    lines.push(...(i > 0 ? [""] : []), head, `     ${facts.join("  ·  ")}`);
  });
  if (sorted.length > ACTIVE_ALERTS_MAX) lines.push("", `… and ${sorted.length - ACTIVE_ALERTS_MAX} more`);
  lines.push("", "<i>Returns are on the market cap at each alert.</i>");
  lines.push(updatedText(now));
  if (floorNote) lines.push(floorNote);
  const dash = dashboardLink(links, "Open the Live feed");
  if (dash) lines.push(dash);
  return lines.join("\n");
}

function windowName(hours: number): string {
  return hours % 24 === 0 && hours >= 48 ? `${hours / 24}d` : `${hours}h`;
}

/**
 * "Updated 14:05 UTC": a board is one message that stays in the chat, refreshed only when someone
 * presses its button, so without its time an hours-old board read as the numbers now.
 */
export function updatedText(now: number): string {
  const at = new Date(now);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `<i>Updated ${hh}:${mm} UTC</i>`;
}

function sinceText(at: Date): string {
  const month = at.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${month} ${at.getUTCDate()}, ${hh}:${mm} UTC`;
}

/** The /trenchboard answer for one window; the buttons under it pick another. */
export function formatTrenchboard(stats: BoardStats, now = Date.now()): string {
  const lines = [`🏆 <b>Trenchboard</b>  ·  last ${windowName(stats.hours)}`, DIVIDER];
  if (stats.alerts === 0) {
    lines.push("No alerts in this chat over this window.");
  } else {
    lines.push(`🔔 Alerts  <b>${stats.alerts}</b>`);
    const hit = stats.graded > 0 ? `<b>${Math.round((stats.won / stats.graded) * 100)}%</b>` : "<b>–</b>";
    lines.push(`🎯 2x hit rate  ${hit}  (${stats.won} W · ${stats.lost} L)`);
    lines.push(
      stats.avgReturnPct !== null
        ? `💵 Avg return  <b>${signedPct(stats.avgReturnPct)}</b>  over ${stats.settled} settled`
        : "💵 Avg return  <b>–</b>  (none settled yet)",
    );
    if (stats.pending > 0) lines.push(`⏳ ${stats.pending} still in their 15-minute window`);
    if (stats.best)
      lines.push(`🚀 Best  <b>${escapeHtml(label(stats.best))}</b>  ${signedPct(stats.best.peakPct)}`);
  }
  lines.push("", "<i>A win is a clean 2x within 15 minutes; the return is the exit plan's.</i>");
  if (stats.recordedSince) lines.push(`<i>Counting from ${sinceText(stats.recordedSince)}.</i>`);
  lines.push(updatedText(now));
  return lines.join("\n");
}
