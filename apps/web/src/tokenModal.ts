import type { Card } from "./api";

/**
 * The open token modal, held above the feed rather than inside the card that opened it. A card
 * leaves the feed for many reasons while its modal is open (the visibility cutoff in Customize, the
 * feed's length cap, a filter or model toggled off), and the modal stays until its reader closes
 * it. The card keeps the modal's copy fresh while it's still on screen; once it's gone, the last
 * copy it sent stays up.
 */
/** `scope`: opened from the Scope board, which gets the desktop terminal layout (user ask 2026-10-18). */
export type OpenTokenModal = { card: Card; now: number; scope?: boolean };

let current: OpenTokenModal | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

export function subscribeTokenModal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openTokenModalState(): OpenTokenModal | null {
  return current;
}

/** Opens the modal on this card, replacing any other. */
export function openTokenModal(card: Card, now: number, scope = false): void {
  current = scope ? { card, now, scope } : { card, now };
  emit();
}

/** A newer copy of the card whose modal is open; a no-op for any other card. */
export function refreshTokenModal(card: Card, now: number): void {
  if (!current || current.card.id !== card.id) return;
  if (current.card === card && current.now === now) return;
  current = { ...current, card, now };
  emit();
}

export function closeTokenModal(): void {
  if (!current) return;
  current = null;
  emit();
}
