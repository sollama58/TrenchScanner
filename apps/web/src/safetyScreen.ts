import type { Card, Snapshot } from "./api";
import {
  SAFETY_COUNT_CUT_HOLDERS,
  SAFETY_MAX_FRESH_WALLET_PCT,
  SAFETY_MAX_LARGEST_HOLDER_PCT,
  SAFETY_REJECT_CEX_FUNDED_COUNT,
  SAFETY_REJECT_EMPTY_WALLET_PCT,
  SAFETY_REJECT_LINKED_COUNT,
  SAFETY_REJECT_SNIPER_WALLET_PCT,
  SAFETY_REJECT_TOP10_HOLDER_PCT,
  countCutFor,
} from "./components/AlertCard";
import { pct } from "./format";

/**
 * The safety screen's verdict on a coin, as the token view's header pill and Safety section show it
 * (user ask 2026-10-16): the newest scan's, since a coin that passed at its alert can fail later.
 */
export interface SafetyVerdict {
  /** "pending": no scan has screened it yet (a lookup's first scan is still on its way). */
  state: "passed" | "failed" | "pending";
  /** The scan the verdict is from; null while pending. */
  reading: Snapshot | null;
  /** Why it failed, in the screen's words with a capital first letter; empty when it passed. */
  reasons: string[];
  /** The alert's own reading passed and a newer scan fails it. */
  passedAtAlert: boolean;
}

/** The newest screened reading of a card's coin, and what the screen made of it. */
export function safetyVerdict(card: Card, scanning: boolean): SafetyVerdict {
  const pending: SafetyVerdict = { state: "pending", reading: null, reasons: [], passedAtAlert: false };
  if (scanning) return pending;
  const screened = [card.latestSnapshot, card.snapshot].filter(
    (s): s is Snapshot => !!s && typeof s.rugScreenPassed === "boolean",
  );
  if (screened.length === 0) return pending;
  const reading = screened.reduce((a, b) => (Date.parse(b.takenAt) > Date.parse(a.takenAt) ? b : a));
  const passed = reading.rugScreenPassed === true;
  return {
    state: passed ? "passed" : "failed",
    reading,
    reasons: passed
      ? []
      : (reading.rugScreenReasons ?? []).map((r) => r.charAt(0).toUpperCase() + r.slice(1)),
    passedAtAlert: !passed && reading !== card.snapshot && card.snapshot.rugScreenPassed === true,
  };
}

/** One of the screen's rules, read off a scan: what it measured and whether that clears the cut. */
export interface SafetyCheck {
  label: string;
  /** The reading, or "Not read". */
  value: string;
  status: "ok" | "fail" | "unknown";
  /** The cut, in words. */
  rule: string;
}

const NOT_READ = "Not read";
const UNVERIFIED = "Unverified (fails closed)";

/**
 * A yes/no reading where `bad` is the failing answer. With `unreadFails`, a reading the scan
 * didn't get fails, as core's screen fails closed on it.
 */
function flag(
  label: string,
  v: boolean | null | undefined,
  bad: boolean,
  [yes, no]: [string, string],
  rule: string,
  unreadFails = false,
): SafetyCheck {
  if (typeof v !== "boolean")
    return unreadFails
      ? { label, value: UNVERIFIED, status: "fail", rule }
      : { label, value: NOT_READ, status: "unknown", rule };
  return { label, value: v ? yes : no, status: v === bad ? "fail" : "ok", rule };
}

/** A share or count against its cut: failing when `fails` says so. */
function measured(
  label: string,
  v: number | null | undefined,
  text: (v: number) => string,
  fails: (v: number) => boolean,
  rule: string,
): SafetyCheck {
  if (typeof v !== "number" || !Number.isFinite(v))
    return { label, value: NOT_READ, status: "unknown", rule };
  return { label, value: text(v), status: fails(v) ? "fail" : "ok", rule };
}

/**
 * Every rule the safety screen applies (core's runRugScreen), read off one scan, in the screen's
 * order. A wallet or share cut the scan didn't read is "Not read": the screen lets those through.
 * An unread liquidity or Mayhem Mode check fails, as the screen fails closed on those (Mayhem is
 * looked up only once the authority and liquidity checks pass, so it stays "Not read" after one of
 * them failed). The bonding curve's fill time is not kept on the scan, so it shows only among a
 * failed verdict's reasons.
 */
export function safetyChecks(s: Snapshot): SafetyCheck[] {
  const freshCounted = typeof s.freshTopHolderCount === "number" && (s.freshTopHoldersChecked ?? 0) > 0;
  const freshShare = freshCounted
    ? (s.freshTopHolderCount! / s.freshTopHoldersChecked!) * 100
    : (s.freshTop10WalletPct ?? null);
  const linkedOf = s.linkedWalletsChecked ?? SAFETY_COUNT_CUT_HOLDERS;
  const linkedCut = countCutFor(SAFETY_REJECT_LINKED_COUNT, s.linkedWalletsChecked);
  const cexOf = s.cexFundedHolders ?? SAFETY_COUNT_CUT_HOLDERS;
  const cexCut = countCutFor(SAFETY_REJECT_CEX_FUNDED_COUNT, s.cexFundedHolders);
  const localFailed =
    s.mintAuthorityActive === true || s.freezeAuthorityActive === true || s.lpBurned !== true;
  return [
    flag("Mint authority", s.mintAuthorityActive, true, ["Active", "Renounced"], "Must be renounced"),
    flag("Freeze authority", s.freezeAuthorityActive, true, ["Active", "Renounced"], "Must be renounced"),
    flag(
      "Liquidity",
      s.lpBurned,
      false,
      ["Burned or locked", "Not locked"],
      "Must be burned or locked",
      true,
    ),
    flag("Mayhem Mode", s.isMayhemMode, true, ["Yes", "No"], "Mayhem Mode coins fail", !localFailed),
    measured(
      "Top 10 holders",
      s.top10HolderPct,
      (v) => pct(v),
      (v) => v >= SAFETY_REJECT_TOP10_HOLDER_PCT,
      `Fails at ${SAFETY_REJECT_TOP10_HOLDER_PCT}% of supply or more`,
    ),
    measured(
      "Largest holder",
      s.largestHolderPct,
      (v) => pct(v, 1),
      (v) => v > SAFETY_MAX_LARGEST_HOLDER_PCT,
      `Fails over ${SAFETY_MAX_LARGEST_HOLDER_PCT}% of supply`,
    ),
    measured(
      "Fresh wallets",
      freshShare,
      (v) => (freshCounted ? `${s.freshTopHolderCount}/${s.freshTopHoldersChecked}` : pct(v)),
      (v) => v > SAFETY_MAX_FRESH_WALLET_PCT,
      `Fails over ${SAFETY_MAX_FRESH_WALLET_PCT}% of top holders`,
    ),
    measured(
      "Empty wallets",
      s.emptyTop10WalletPct,
      (v) => pct(v),
      (v) => v >= SAFETY_REJECT_EMPTY_WALLET_PCT,
      `Fails at ${SAFETY_REJECT_EMPTY_WALLET_PCT}% of the top 10 or more`,
    ),
    measured(
      "Launch snipers",
      s.sniperTop10WalletPct,
      (v) => pct(v),
      (v) => v >= SAFETY_REJECT_SNIPER_WALLET_PCT,
      `Fails at ${SAFETY_REJECT_SNIPER_WALLET_PCT}% of the top 10 or more`,
    ),
    measured(
      "Linked holders",
      s.linkedWalletCount,
      (v) => `${v}/${linkedOf}`,
      (v) => v >= linkedCut,
      `Fails at ${linkedCut} of ${linkedOf} or more`,
    ),
    measured(
      "Exchange-funded",
      s.cexFundedCount,
      (v) => `${v}/${cexOf}`,
      (v) => v >= cexCut,
      `Fails at ${cexCut} of ${cexOf} or more`,
    ),
  ];
}

/** The screen's verdict changed on this coin: what it was before, and the last scan that said so. */
export interface SafetyFlip {
  /** The verdict before the flip; the newest scan says the other. */
  was: "passed" | "failed";
  /** The last scan with the old verdict. */
  lastAt: string;
}

/**
 * Whether the screen's verdict flipped (user ask 2026-10-19): the newest scan to give the other
 * verdict than `reading`, among `history` (the coin's recent scans, any order) up to `reading`.
 * Null when every screened scan there agrees with it.
 */
export function safetyFlip(reading: Snapshot, history: readonly Snapshot[]): SafetyFlip | null {
  if (typeof reading.rugScreenPassed !== "boolean") return null;
  const at = Date.parse(reading.takenAt);
  let other: Snapshot | null = null;
  for (const s of history) {
    if (typeof s.rugScreenPassed !== "boolean" || s.rugScreenPassed === reading.rugScreenPassed) continue;
    const t = Date.parse(s.takenAt);
    if (t < at && (!other || t > Date.parse(other.takenAt))) other = s;
  }
  return other ? { was: other.rugScreenPassed ? "passed" : "failed", lastAt: other.takenAt } : null;
}
