/**
 * Whether Helius Sender looks down from this instance (trading robustness audit 2026-10-19, #5):
 * two sends in a row with no answer (a timeout, a 5xx, a dropped connection), or a failed GET
 * /ping, within the last minute. Any answer from Sender, a refusal included, clears it. The trade
 * panel reads it to warn that shielded trades may expire while unshielded ones go through the RPC.
 */
export const SENDER_DOWN_WINDOW_MS = 60_000;
/** Silent sends in a row before Sender reads as down. */
export const SENDER_DOWN_AFTER = 2;
/** At most one ping this often, and only while no send has said anything lately. */
const PING_EVERY_MS = 30_000;

export class SenderHealth {
  private silent = 0;
  private lastSilentAt = -Infinity;
  private lastSignalAt = -Infinity;
  private lastPingAt = -Infinity;

  constructor(private readonly now: () => number = Date.now) {}

  /** One send's outcome: `answered` is any answer from Sender, a refusal included. */
  note(answered: boolean) {
    const at = this.now();
    this.lastSignalAt = at;
    if (answered) {
      this.silent = 0;
      return;
    }
    this.silent++;
    this.lastSilentAt = at;
  }

  /** A ping's outcome: a failed one reads as down for the window on its own. */
  notePing(ok: boolean) {
    if (ok) return this.note(true);
    this.note(false);
    this.silent = Math.max(this.silent, SENDER_DOWN_AFTER);
  }

  get down(): boolean {
    return this.silent >= SENDER_DOWN_AFTER && this.now() - this.lastSilentAt < SENDER_DOWN_WINDOW_MS;
  }

  /** True (and counted as begun) when a ping is due: no send said anything within the window. */
  pingDue(): boolean {
    const at = this.now();
    if (at - this.lastSignalAt < SENDER_DOWN_WINDOW_MS || at - this.lastPingAt < PING_EVERY_MS) return false;
    this.lastPingAt = at;
    return true;
  }
}
