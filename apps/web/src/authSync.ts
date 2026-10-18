/**
 * Sign-in changes, told to this browser's other open tabs.
 *
 * Every tab shares the one session cookie (and session.ts's fallback token), so signing out or
 * switching wallets in one tab changed who the others were signed in as without their knowing:
 * they kept showing the old account for minutes (until App's next session re-read), its settings
 * and feed still on screen, while every request they sent went out as the new one (or signed out).
 * App announces each change here and re-reads its own session when another tab announces one.
 *
 * BroadcastChannel where the browser has it, else a localStorage write (whose `storage` event
 * reaches the other tabs only). Neither delivers to the tab that sent it.
 */
export type AuthChange = { kind: "signed-out" } | { kind: "signed-in"; userId: string };

const CHANNEL = "ts-auth";
const STORAGE_KEY = "ts-auth-change";

let channel: BroadcastChannel | null | undefined;

function openChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    try {
      channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    } catch {
      channel = null;
    }
  }
  return channel;
}

/** Whether `value` is an AuthChange (another tab's message, or a storage value). */
export function parseAuthChange(value: unknown): AuthChange | null {
  const v = value as { kind?: unknown; userId?: unknown } | null;
  if (v?.kind === "signed-out") return { kind: "signed-out" };
  if (v?.kind === "signed-in" && typeof v.userId === "string") return { kind: "signed-in", userId: v.userId };
  return null;
}

/** Tells the other tabs this one signed in (as `userId`) or out. */
export function announceAuthChange(change: AuthChange): void {
  const ch = openChannel();
  if (ch) {
    try {
      ch.postMessage(change);
      return;
    } catch {
      // Closed or refused: fall back to storage below.
    }
  }
  try {
    // A nonce, so the same change twice in a row still fires `storage` (it fires on a new value only).
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...change, at: Date.now(), n: Math.random() }));
  } catch {
    // Storage blocked: the other tabs find out at their next session re-read.
  }
}

/** Calls `callback` with each change another tab announces. Returns the unsubscribe. */
export function onAuthChange(callback: (change: AuthChange) => void): () => void {
  const ch = openChannel();
  const onMessage = (e: MessageEvent) => {
    const change = parseAuthChange(e.data);
    if (change) callback(change);
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      const change = parseAuthChange(JSON.parse(e.newValue));
      if (change) callback(change);
    } catch {
      // Not ours to read.
    }
  };
  ch?.addEventListener("message", onMessage);
  window.addEventListener("storage", onStorage);
  return () => {
    ch?.removeEventListener("message", onMessage);
    window.removeEventListener("storage", onStorage);
  };
}
