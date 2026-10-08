/**
 * Whether this browser has shown the picture tour (AboutModal) to a reader yet, so it opens by
 * itself once: per wallet for signed-in readers, once per browser for guests. Reopened any time
 * from the info button by the feed heading.
 */
const PREFIX = "ts-intro-seen:";

/** The storage key for a wallet, or for guests when there's none. */
export function introKey(walletAddress: string | null): string {
  return PREFIX + (walletAddress ?? "guest");
}

export function introSeen(walletAddress: string | null): boolean {
  try {
    return localStorage.getItem(introKey(walletAddress)) === "1";
  } catch {
    // Storage blocked: don't pop the tour on every visit when we can't remember it was seen.
    return true;
  }
}

export function markIntroSeen(walletAddress: string | null): void {
  try {
    localStorage.setItem(introKey(walletAddress), "1");
  } catch {
    // Storage blocked: nothing to remember it in.
  }
}
