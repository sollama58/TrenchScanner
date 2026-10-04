/**
 * The five alert sounds, synthesized with Web Audio so there are no audio files to ship or cache.
 * The ids are the API's (apps/api/src/alertPrefs.ts ALERT_SOUNDS).
 *
 * Browsers only let a page make sound after the visitor has interacted with it; unlock() is called
 * on the first click or key press, and a ping before that is silently skipped.
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

/** Resumes the audio context; must run inside a user gesture the first time. */
export function unlockAudio(): void {
  const c = context();
  if (c && c.state === "suspended") void c.resume().catch(() => undefined);
}

/** Plays `sound` at `volume` (0-100). Returns false when the browser won't play sound yet. */
export function playAlertSound(sound: AlertSound, volume: number): boolean {
  const c = context();
  if (!c || volume <= 0) return false;
  if (c.state === "suspended") {
    void c.resume().catch(() => undefined);
    if (c.state === "suspended") return false;
  }
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
  return true;
}
