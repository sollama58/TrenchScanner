/**
 * The five alert sounds, synthesized with Web Audio so there are no audio files to ship or cache.
 * The ids are the API's (apps/api/src/alertPrefs.ts ALERT_SOUNDS).
 *
 * Browsers only let a page make sound after the visitor has interacted with it, and phones suspend
 * (or, on iOS, "interrupt") the audio context again whenever the screen locks, the tab is backgrounded
 * or a call comes in. So unlockAudio() runs on every tap and key press while the context isn't
 * running, not just the first, and a ping that finds the context asleep waits for it to resume.
 */

export type AlertSound = "chime" | "ping" | "bell" | "coin" | "radar";

export const ALERT_SOUND_OPTIONS: { id: AlertSound; label: string; hint: string }[] = [
  { id: "chime", label: "Chime", hint: "Two soft rising notes" },
  { id: "ping", label: "Ping", hint: "One short, high blip" },
  { id: "bell", label: "Bell", hint: "A ringing bell that fades out" },
  { id: "coin", label: "Coin", hint: "A quick arcade coin pickup" },
  { id: "radar", label: "Radar", hint: "Three sonar pulses" },
];

type Tone = {
  /** Seconds after the sound starts. */
  at: number;
  freq: number;
  /** Seconds. */
  length: number;
  type?: OscillatorType;
  /** 0-1, before the user's volume. */
  gain?: number;
  /** Glide to this frequency over the tone. */
  glideTo?: number;
};

const SOUNDS: Record<AlertSound, Tone[]> = {
  chime: [
    { at: 0, freq: 880, length: 0.35, type: "sine", gain: 0.6 },
    { at: 0.14, freq: 1318.5, length: 0.5, type: "sine", gain: 0.5 },
  ],
  ping: [{ at: 0, freq: 1760, length: 0.18, type: "sine", gain: 0.7 }],
  bell: [
    { at: 0, freq: 660, length: 1.2, type: "sine", gain: 0.55 },
    { at: 0, freq: 1320, length: 0.8, type: "sine", gain: 0.2 },
    { at: 0, freq: 1980, length: 0.5, type: "sine", gain: 0.1 },
  ],
  coin: [
    { at: 0, freq: 987.8, length: 0.08, type: "square", gain: 0.25 },
    { at: 0.08, freq: 1318.5, length: 0.3, type: "square", gain: 0.25 },
  ],
  radar: [
    { at: 0, freq: 1200, length: 0.12, type: "triangle", gain: 0.6, glideTo: 900 },
    { at: 0.2, freq: 1200, length: 0.12, type: "triangle", gain: 0.45, glideTo: 900 },
    { at: 0.4, freq: 1200, length: 0.12, type: "triangle", gain: 0.3, glideTo: 900 },
  ],
};

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** Whether the context can make sound now ("interrupted" is iOS Safari's extra paused state). */
function running(c: AudioContext): boolean {
  return c.state === "running";
}

/**
 * Wakes the audio context. Inside a user gesture this also plays one silent sample, which older
 * iOS Safari needs before it will let Web Audio out of the speaker at all.
 */
export function unlockAudio(): void {
  const c = context();
  if (!c || running(c)) return;
  void c.resume().catch(() => undefined);
  try {
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, 22050);
    src.connect(c.destination);
    src.start(0);
  } catch {
    // Nothing to do: resume() above is the part that matters on current browsers.
  }
}

/** How long a ping waits for a sleeping context to come back before giving up on that ping. */
const RESUME_WAIT_MS = 1500;

/**
 * Plays `sound` at `volume` (0-100). When the context is asleep (phone locked, tab backgrounded)
 * it asks to resume and plays once it does. Returns false when there is nothing to play on.
 */
export function playAlertSound(sound: AlertSound, volume: number): boolean {
  const c = context();
  if (!c || volume <= 0) return false;
  if (running(c)) {
    schedule(c, sound, volume);
    return true;
  }
  const asked = Date.now();
  void c
    .resume()
    .then(() => {
      // A late resume would make a stale ping land on top of a newer one.
      if (running(c) && Date.now() - asked < RESUME_WAIT_MS) schedule(c, sound, volume);
    })
    .catch(() => undefined);
  return true;
}

function schedule(c: AudioContext, sound: AlertSound, volume: number): void {
  // Perceived loudness is roughly logarithmic: square the slider so 50% sounds like half.
  const master = c.createGain();
  master.gain.value = Math.min(1, Math.max(0, volume / 100)) ** 2;
  master.connect(c.destination);
  const start = c.currentTime + 0.01;
  for (const tone of SOUNDS[sound] ?? SOUNDS.chime) {
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = tone.type ?? "sine";
    osc.frequency.setValueAtTime(tone.freq, start + tone.at);
    if (tone.glideTo) osc.frequency.exponentialRampToValueAtTime(tone.glideTo, start + tone.at + tone.length);
    const peak = tone.gain ?? 0.5;
    env.gain.setValueAtTime(0.0001, start + tone.at);
    env.gain.exponentialRampToValueAtTime(peak, start + tone.at + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, start + tone.at + tone.length);
    osc.connect(env);
    env.connect(master);
    osc.start(start + tone.at);
    osc.stop(start + tone.at + tone.length + 0.05);
  }
}
