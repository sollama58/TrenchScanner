import { useMemo, useSyncExternalStore } from "react";
import { put, type Card } from "./api";
import { nowReading, recordedPeakOf } from "./components/AlertCard";

/**
 * Tokens hidden from the Live feed's Cards and Scope views (user ask 2026-10-19). Saved to the
 * account (PUT /settings/hidden-tokens) so the list follows the user to every device, and kept in
 * localStorage too so this device applies it at once, before the settings load, and keeps it if a
 * save fails. apps/api/src/hiddenTokens.ts holds the same names and bounds.
 *
 * With auto-unhide on (the default), a hidden token comes back by itself when it graduates or
 * reaches a multiple (2x, 4x, 10x from the alert it was hidden on) it hadn't when it was hidden.
 */

export interface HiddenToken {
  tokenId: string;
  mintAddress: string | null;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  hiddenAt: string;
  /** The market cap of the alert it was hidden on: the multiples count from it. */
  baseMcapUsd: number | null;
  /** The highest of UNHIDE_MULTIPLES it had already reached when hidden (0: none). */
  reachedX: number;
  /** Whether it had already graduated when hidden. */
  graduated: boolean;
}

export interface HiddenTokens {
  autoUnhide: boolean;
  tokens: HiddenToken[];
}

export const MAX_HIDDEN_TOKENS = 500;
export const UNHIDE_MULTIPLES = [2, 4, 10] as const;
export const DEFAULT_HIDDEN_TOKENS: HiddenTokens = { autoUnhide: true, tokens: [] };

const HIDDEN_KEY = "ts-hidden-tokens";
/**
 * Set while this device's list failed to reach the account (a 413 past the body limit, a network
 * error), so a later load doesn't adopt the account's older copy over it (audit 2026-10-23, AS-1).
 */
const UNSAVED_KEY = "ts-hidden-tokens-unsaved";
const SAVE_DELAY_MS = 600;

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Anything read back (localStorage, an API build ahead or behind) as a valid list. */
export function normalizeHiddenTokens(raw: unknown): HiddenTokens {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tokens: HiddenToken[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(r.tokens) ? r.tokens : []) {
    const t = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const tokenId = str(t.tokenId, 64);
    const hiddenAt = str(t.hiddenAt, 40);
    if (!tokenId || !hiddenAt || !Number.isFinite(Date.parse(hiddenAt)) || seen.has(tokenId)) continue;
    seen.add(tokenId);
    tokens.push({
      tokenId,
      mintAddress: str(t.mintAddress, 64),
      symbol: str(t.symbol, 64),
      name: str(t.name, 128),
      imageUrl: str(t.imageUrl, 512),
      hiddenAt,
      baseMcapUsd: num(t.baseMcapUsd),
      reachedX: num(t.reachedX) ?? 0,
      graduated: t.graduated === true,
    });
  }
  return {
    autoUnhide: typeof r.autoUnhide === "boolean" ? r.autoUnhide : DEFAULT_HIDDEN_TOKENS.autoUnhide,
    tokens: tokens.slice(-MAX_HIDDEN_TOKENS),
  };
}

// ---- Measuring a token ----

/** Whether a card's coin has graduated, by its own scans or by `gradTokens` (Scope's Graduated list). */
export function cardGraduatedNow(card: Card, gradTokens?: ReadonlySet<string>): boolean {
  return (
    card.token.graduated === true ||
    card.latestSnapshot?.graduated === true ||
    card.snapshot.graduated === true ||
    (gradTokens?.has(card.tokenId) ?? false)
  );
}

/** The highest market cap a card has seen since its alert: its recorded peak, or now if higher. */
export function peakMcapOf(card: Card): number | null {
  const alertMcap = card.snapshot.marketCapUsd;
  const { pct } = recordedPeakOf(card);
  const recorded = pct !== null && alertMcap > 0 ? alertMcap * (1 + pct / 100) : null;
  const now = nowReading(card);
  if (recorded === null) return now;
  return now === null ? recorded : Math.max(recorded, now);
}

/** The highest of UNHIDE_MULTIPLES that `x` reaches (0: none). */
export function multipleReached(x: number): number {
  let out = 0;
  for (const m of UNHIDE_MULTIPLES) if (x >= m) out = m;
  return out;
}

function tokenPeak(cards: readonly Card[]): number | null {
  let peak: number | null = null;
  for (const c of cards) {
    const p = peakMcapOf(c);
    if (p !== null && (peak === null || p > peak)) peak = p;
  }
  return peak;
}

/**
 * The entry for hiding `card`'s token. `related` are the token's other cards on screen (its other
 * alerts): their peaks count as already reached, so an older alert's earlier run doesn't bring it
 * straight back.
 */
export function hiddenEntry(
  card: Card,
  related: readonly Card[] = [],
  gradTokens?: ReadonlySet<string>,
  at = new Date(),
): HiddenToken {
  const cards = [card, ...related.filter((c) => c.tokenId === card.tokenId && c !== card)];
  const base = card.snapshot.marketCapUsd > 0 ? card.snapshot.marketCapUsd : null;
  const peak = tokenPeak(cards);
  return {
    tokenId: card.tokenId,
    mintAddress: card.token.mintAddress ?? null,
    symbol: card.token.symbol,
    name: card.token.name,
    imageUrl: card.token.imageUrl,
    hiddenAt: at.toISOString(),
    baseMcapUsd: base,
    reachedX: base !== null && peak !== null ? multipleReached(peak / base) : 0,
    graduated: cards.some((c) => cardGraduatedNow(c, gradTokens)),
  };
}

/** Why a hidden token is due to come back (auto-unhide), or null while it stays hidden. */
export function unhideReason(
  entry: HiddenToken,
  cards: readonly Card[],
  gradTokens?: ReadonlySet<string>,
): string | null {
  if (!entry.graduated && cards.some((c) => cardGraduatedNow(c, gradTokens))) return "graduated";
  if (entry.baseMcapUsd === null || entry.baseMcapUsd <= 0) return null;
  const peak = tokenPeak(cards);
  if (peak === null) return null;
  const x = multipleReached(peak / entry.baseMcapUsd);
  return x > entry.reachedX ? `hit ${x}x` : null;
}

/** The hidden tokens among `cards` that auto-unhide brings back now. */
export function dueToUnhide(
  state: HiddenTokens,
  cards: readonly Card[],
  gradTokens?: ReadonlySet<string>,
): string[] {
  if (!state.autoUnhide || state.tokens.length === 0) return [];
  const byToken = new Map<string, Card[]>();
  const hidden = new Set(state.tokens.map((t) => t.tokenId));
  for (const c of cards) {
    if (!hidden.has(c.tokenId)) continue;
    const list = byToken.get(c.tokenId);
    if (list) list.push(c);
    else byToken.set(c.tokenId, [c]);
  }
  return state.tokens
    .filter((t) => {
      const mine = byToken.get(t.tokenId);
      return mine !== undefined && unhideReason(t, mine, gradTokens) !== null;
    })
    .map((t) => t.tokenId);
}

// ---- The store ----

function readLocal(): HiddenTokens {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    return raw ? normalizeHiddenTokens(JSON.parse(raw)) : DEFAULT_HIDDEN_TOKENS;
  } catch {
    return DEFAULT_HIDDEN_TOKENS;
  }
}

function writeLocal(h: HiddenTokens) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(h));
  } catch {
    // Storage blocked or full: the account copy still has it.
  }
}

function markUnsaved(on: boolean) {
  try {
    if (on) localStorage.setItem(UNSAVED_KEY, "1");
    else localStorage.removeItem(UNSAVED_KEY);
  } catch {
    // Storage blocked: a reload then adopts the account's copy, as before.
  }
}

function isUnsaved(): boolean {
  try {
    return localStorage.getItem(UNSAVED_KEY) !== null;
  } catch {
    return false;
  }
}

let current: HiddenTokens = readLocal();
/** Bumped by every local change, so a settings load that started before it doesn't undo it. */
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Another window of the dashboard changed it: show the same list here. Only shown - that window
// saves it to the account.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== HIDDEN_KEY) return;
    current = readLocal();
    emit();
  });
}

export function useHiddenTokens(): HiddenTokens {
  return useSyncExternalStore(subscribe, () => current);
}

/** The hidden tokens' ids, for filtering a feed. */
export function useHiddenTokenIds(): ReadonlySet<string> {
  const h = useHiddenTokens();
  return useMemo(() => new Set(h.tokens.map((t) => t.tokenId)), [h]);
}

/** The local version now; pass it to adoptHiddenTokens with what a settings load returned. */
export function hiddenTokensVersion(): number {
  return version;
}

/**
 * Takes the account's saved list (from GET /settings), unless this device changed it since that
 * request went out or still has a save on the way. An API build without it sends nothing.
 */
export function adoptHiddenTokens(saved: unknown, sinceVersion: number): void {
  if (saved === undefined || version !== sinceVersion || timer !== null || inflight > 0) return;
  // The last save failed: this device's list is the newer one, so send it again instead.
  if (isUnsaved()) {
    void save();
    return;
  }
  const next = normalizeHiddenTokens(saved);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  writeLocal(current);
  emit();
}

function change(next: HiddenTokens) {
  current = normalizeHiddenTokens(next);
  version++;
  writeLocal(current);
  emit();
  if (timer) clearTimeout(timer);
  // Quick hides in a row go in one save.
  timer = setTimeout(() => {
    timer = null;
    void save();
  }, SAVE_DELAY_MS);
}

async function save() {
  inflight++;
  try {
    await put<{ hiddenTokens: HiddenTokens }>("/settings/hidden-tokens", current);
    markUnsaved(false);
  } catch (err) {
    // Kept on this device either way; the next change or settings load tries the account again.
    console.warn("hidden tokens not saved to the account", err);
    markUnsaved(true);
  } finally {
    inflight--;
  }
}

/** Hides a card's token from Cards and Scope. See hiddenEntry for `related`. */
export function hideToken(card: Card, related: readonly Card[] = [], gradTokens?: ReadonlySet<string>): void {
  const entry = hiddenEntry(card, related, gradTokens);
  change({ ...current, tokens: [...current.tokens.filter((t) => t.tokenId !== card.tokenId), entry] });
}

export function unhideTokens(tokenIds: readonly string[]): void {
  if (tokenIds.length === 0) return;
  const drop = new Set(tokenIds);
  change({ ...current, tokens: current.tokens.filter((t) => !drop.has(t.tokenId)) });
}

export function unhideAll(): void {
  change({ ...current, tokens: [] });
}

export function setAutoUnhide(on: boolean): void {
  change({ ...current, autoUnhide: on });
}

/**
 * Forgets this device's copy when its account signs out, so the next account to sign in here
 * neither sees nor saves this one's list. The bump makes a settings load still on its way skip.
 */
export function resetHiddenTokens(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  version++;
  current = DEFAULT_HIDDEN_TOKENS;
  try {
    localStorage.removeItem(HIDDEN_KEY);
    localStorage.removeItem(UNSAVED_KEY);
  } catch {
    // Storage blocked: nothing was kept there either.
  }
  emit();
}
