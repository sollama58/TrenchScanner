import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Just enough of an AudioContext to count scheduled oscillators. */
class FakeContext {
  state: string = "suspended";
  currentTime = 0;
  destination = {};
  started = 0;
  resumeWorks = true;
  resume = vi.fn(async () => {
    if (this.resumeWorks) this.state = "running";
  });
  createGain() {
    const param = { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
    return { gain: param, connect() {} };
  }
  createOscillator() {
    const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
    return { type: "sine", frequency: param, connect() {}, start: () => this.started++, stop() {} };
  }
  createBuffer() {
    return {};
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() {} };
  }
}

let fake: FakeContext;

beforeEach(() => {
  vi.resetModules();
  fake = new FakeContext();
  vi.stubGlobal("window", { AudioContext: vi.fn(() => fake) });
});

afterEach(() => vi.unstubAllGlobals());

describe("playAlertSound", () => {
  it("plays straight away on a running context", async () => {
    const { playAlertSound } = await import("./alertSounds");
    fake.state = "running";
    expect(playAlertSound("ping", 50)).toBe(true);
    expect(fake.started).toBe(1);
  });

  it("waits for a suspended context to resume, then plays", async () => {
    const { playAlertSound } = await import("./alertSounds");
    expect(playAlertSound("chime", 50)).toBe(true);
    expect(fake.started).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.started).toBe(2);
  });

  it("resumes an iOS-interrupted context too", async () => {
    const { playAlertSound } = await import("./alertSounds");
    fake.state = "interrupted";
    playAlertSound("ping", 50);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.resume).toHaveBeenCalled();
    expect(fake.started).toBe(1);
  });

  it("skips the ping when the context can't resume", async () => {
    const { playAlertSound } = await import("./alertSounds");
    fake.resumeWorks = false;
    playAlertSound("ping", 50);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.started).toBe(0);
  });
});

describe("unlockAudio", () => {
  it("wakes the context on every gesture while it's asleep", async () => {
    const { unlockAudio } = await import("./alertSounds");
    unlockAudio();
    expect(fake.resume).toHaveBeenCalledTimes(1);
    fake.state = "suspended"; // the phone locked
    unlockAudio();
    expect(fake.resume).toHaveBeenCalledTimes(2);
    unlockAudio(); // running now: nothing to do
    expect(fake.resume).toHaveBeenCalledTimes(2);
  });
});
