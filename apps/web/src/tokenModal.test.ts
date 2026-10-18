import { describe, expect, it } from "vitest";
import type { Card } from "./api";
import {
  closeTokenModal,
  openTokenModal,
  openTokenModalState,
  refreshTokenModal,
  subscribeTokenModal,
} from "./tokenModal";

const card = (id: string, mcap = 1): Card => ({ id, snapshot: { marketCapUsd: mcap } }) as unknown as Card;

describe("token modal", () => {
  it("stays open with the last copy once the card stops refreshing it", () => {
    const a = card("a");
    openTokenModal(a, 100);
    // The card leaves the feed: nothing refreshes or closes it, so the modal stays as it was.
    expect(openTokenModalState()).toEqual({ card: a, now: 100 });
    closeTokenModal();
    expect(openTokenModalState()).toBeNull();
  });

  it("takes newer copies of its own card only", () => {
    let calls = 0;
    const off = subscribeTokenModal(() => calls++);
    openTokenModal(card("a"), 100);
    const fresher = card("a", 2);
    refreshTokenModal(fresher, 200);
    refreshTokenModal(card("b"), 300);
    refreshTokenModal(fresher, 200);
    expect(openTokenModalState()).toEqual({ card: fresher, now: 200 });
    expect(calls).toBe(2);
    closeTokenModal();
    refreshTokenModal(fresher, 400);
    expect(openTokenModalState()).toBeNull();
    off();
  });

  it("keeps a Scope opening's layout as its card refreshes", () => {
    const a = card("a");
    openTokenModal(a, 100, true);
    refreshTokenModal(card("a", 2), 200);
    expect(openTokenModalState()?.scope).toBe(true);
    closeTokenModal();
  });
});
