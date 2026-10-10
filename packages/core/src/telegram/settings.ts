import type { InlineKeyboard } from "./api.js";
import {
  ALERT_LINKS,
  ALERT_LINK_LABELS,
  ALERT_PARTS,
  DIVIDER,
  alertImage,
  alertParts,
  alertStyle,
  formatAlert,
  isAlertLink,
  isAlertPart,
  shortUsd,
  type AlertCard,
  type AlertLinks,
  type AlertMessage,
  type AlertPart,
} from "./format.js";

/**
 * /settings: one message with buttons that change, for this chat, what each alert shows, its
 * layout, which links it carries and the /alerts market cap floor. Every press rewrites the same
 * message with the new state; "Preview" sends a sample alert in the chat's current style. The
 * same switches as /show, /hide and /mincap, and the Filters tab's for the parts.
 */

/** What a chat has set; the TelegramChat columns of the same names. */
export interface ChatSettings {
  hidden: string[];
  layout: string;
  links: string[];
  alertsMinMcapUsd: number;
}

/** The market cap floors /settings offers for /alerts; any other value can be set with /mincap. */
export const MCAP_FLOORS = [0, 5_000, 10_000, 25_000, 50_000, 100_000] as const;
export const DEFAULT_MCAP_FLOOR = 5_000;
/** The highest floor /mincap takes. */
export const MAX_MCAP_FLOOR = 100_000_000;

export const SETTINGS_CALLBACK_PREFIX = "st:";

/** The parts as buttons, in card order, with short names that fit three to a row. */
const PART_BUTTONS: { part: AlertPart; label: string }[] = [
  { part: "image", label: "Picture" },
  { part: "stats", label: "Market cap" },
  { part: "holders", label: "Holders" },
  { part: "volume", label: "Volume" },
  { part: "age", label: "Age" },
  { part: "conviction", label: "Conviction" },
  { part: "calibrated", label: "2x rate" },
  { part: "reasons", label: "Reasons" },
  { part: "filters", label: "Filters" },
  { part: "mint", label: "Mint" },
  { part: "links", label: "Links" },
  { part: "sage", label: "TokenSage" },
];

/** "10k", "$25k", "1.5m", "250000", "off" -> USD; null when it isn't a market cap. */
export function parseMcap(text: string): number | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[$,\s]/g, "");
  if (t === "off" || t === "none" || t === "0") return 0;
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1);
  return Number.isFinite(n) && n <= MAX_MCAP_FLOOR ? Math.round(n) : null;
}

export function floorText(usdFloor: number): string {
  return usdFloor > 0 ? shortUsd(usdFloor) : "off";
}

function rows<T>(items: T[], per: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += per) out.push(items.slice(i, i + per));
  return out;
}

/** The settings message: what each alert in this chat looks like now, and how to change it. */
export function formatSettings(s: ChatSettings): string {
  const parts = alertParts(s.hidden);
  const style = alertStyle(s);
  const on = PART_BUTTONS.filter((b) => parts[b.part]).map((b) => b.label);
  const off = PART_BUTTONS.filter((b) => !parts[b.part]).map((b) => b.label);
  return [
    "⚙️ <b>Alert settings</b>  ·  this chat",
    DIVIDER,
    `🧱 Layout  <b>${style.layout === "compact" ? "Compact" : "Full"}</b>`,
    `👁 Showing  ${on.join(", ") || "only the token"}`,
    ...(off.length > 0 ? [`🙈 Hidden  ${off.join(", ")}`] : []),
    `🔗 Links  ${style.links.map((l) => ALERT_LINK_LABELS[l]).join(", ") || "none"}`,
    `📡 /alerts floor  <b>${floorText(s.alertsMinMcapUsd)}</b> market cap`,
    "",
    "<i>Tap to change. Rows: layout, what shows, links, the /alerts floor.</i>",
  ].join("\n");
}

/** The buttons under it: layout, the parts, the links, the floors, and a preview. */
export function settingsKeyboard(s: ChatSettings): InlineKeyboard {
  const parts = alertParts(s.hidden);
  const style = alertStyle(s);
  const p = SETTINGS_CALLBACK_PREFIX;
  const mark = (on: boolean, label: string) => `${on ? "✅" : "▫️"} ${label}`;
  return {
    inline_keyboard: [
      [
        { text: style.layout === "full" ? "• Full •" : "Full", callback_data: `${p}lay:full` },
        { text: style.layout === "compact" ? "• Compact •" : "Compact", callback_data: `${p}lay:compact` },
      ],
      ...rows(
        PART_BUTTONS.map((b) => ({ text: mark(parts[b.part], b.label), callback_data: `${p}p:${b.part}` })),
        3,
      ),
      ...rows(
        ALERT_LINKS.map((l) => ({
          text: mark(style.links.includes(l), ALERT_LINK_LABELS[l]),
          callback_data: `${p}k:${l}`,
        })),
        3,
      ),
      MCAP_FLOORS.map((f) => ({
        text: f === s.alertsMinMcapUsd ? `• ${floorText(f)} •` : floorText(f),
        callback_data: `${p}m:${f}`,
      })),
      [{ text: "👁 Preview an alert", callback_data: `${p}prev` }],
    ],
  };
}

/** What a press asks for: a change to the settings, a preview, or nothing this knows. */
export type SettingsPress = { kind: "change"; settings: ChatSettings } | { kind: "preview" } | null;

/** Applies a press on the settings buttons to a chat's settings. */
export function applySettingsPress(s: ChatSettings, data: string): SettingsPress {
  if (!data.startsWith(SETTINGS_CALLBACK_PREFIX)) return null;
  const [what, value = ""] = data.slice(SETTINGS_CALLBACK_PREFIX.length).split(":");
  switch (what) {
    case "prev":
      return { kind: "preview" };
    case "lay":
      if (value !== "full" && value !== "compact") return null;
      return { kind: "change", settings: { ...s, layout: value } };
    case "p": {
      if (!isAlertPart(value)) return null;
      const hidden = new Set(s.hidden);
      if (hidden.has(value)) hidden.delete(value);
      else hidden.add(value);
      return { kind: "change", settings: { ...s, hidden: ALERT_PARTS.filter((x) => hidden.has(x)) } };
    }
    case "k": {
      if (!isAlertLink(value)) return null;
      const links = new Set(alertStyle(s).links);
      if (links.has(value)) links.delete(value);
      else links.add(value);
      return { kind: "change", settings: { ...s, links: ALERT_LINKS.filter((l) => links.has(l)) } };
    }
    case "m": {
      const floor = Number(value);
      if (!(MCAP_FLOORS as readonly number[]).includes(floor)) return null;
      return { kind: "change", settings: { ...s, alertsMinMcapUsd: floor } };
    }
    default:
      return null;
  }
}

/** A sample alert in the chat's current style: a model call your filter also caught. */
export function formatPreviewMessage(s: ChatSettings, links: AlertLinks, now = Date.now()): AlertMessage {
  const parts = alertParts(s.hidden);
  const card: AlertCard = {
    token: {
      mintAddress: "So11111111111111111111111111111111111111112",
      symbol: "PREVIEW",
      name: "Sample alert",
      firstSeenAt: new Date(now - 14 * 60_000),
      imageUrl: null,
    },
    snapshot: { marketCapUsd: 42_000, holderCount: 120, volume1hUsd: 18_000 },
    filters: [{ name: "your filter", score: 71 }],
    calls: [
      {
        modelName: "Atlas",
        confidence: 72,
        tier: "high",
        calibratedPct: 58,
        reasons: ["Buyers keep arriving", "Dev wallet sold nothing", "Volume rising for 10 minutes"],
        narrativeVerdict: null,
      },
    ],
    raisedAt: new Date(now),
  };
  const html = formatAlert(card, links, now, parts, alertStyle(s)).replace(/^🟢 <b>/, "🔔 <b>");
  const base = links.dashboardUrl.replace(/\/$/, "");
  return {
    html,
    imageUrl: parts.image && base.startsWith("https://") ? `${base}/icon-512.png` : alertImage(card.token),
  };
}
