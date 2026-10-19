import { describe, expect, it } from "vitest";
import { SenderHealth, SENDER_DOWN_WINDOW_MS } from "./senderHealth.js";

describe("Sender's health", () => {
  const clock = () => {
    const c = { t: 1_000_000, now: () => c.t };
    return c;
  };

  it("reads as down after two silent sends in a row, until Sender answers", () => {
    const c = clock();
    const h = new SenderHealth(c.now);
    h.note(false);
    expect(h.down).toBe(false);
    h.note(false);
    expect(h.down).toBe(true);
    // A refusal is an answer too: Sender is up.
    h.note(true);
    expect(h.down).toBe(false);
  });

  it("forgets silent sends older than the window", () => {
    const c = clock();
    const h = new SenderHealth(c.now);
    h.note(false);
    h.note(false);
    c.t += SENDER_DOWN_WINDOW_MS;
    expect(h.down).toBe(false);
  });

  it("pings only while sends have said nothing lately, and a failed ping reads as down", () => {
    const c = clock();
    const h = new SenderHealth(c.now);
    expect(h.pingDue()).toBe(true);
    // One ping at a time.
    expect(h.pingDue()).toBe(false);
    h.notePing(false);
    expect(h.down).toBe(true);
    h.note(true);
    expect(h.down).toBe(false);
    // A send answered just now: no ping needed.
    c.t += 40_000;
    expect(h.pingDue()).toBe(false);
    c.t += SENDER_DOWN_WINDOW_MS;
    expect(h.pingDue()).toBe(true);
    h.notePing(true);
    expect(h.down).toBe(false);
  });
});
