import { seeded } from "./layout";

/**
 * Asyl's wall (user ask 2026-10-24: the theme is a stylised, vector take on an orange-lit wall
 * covered in black marker): a tile of hand-drawn marks, generated from a fixed seed so every visit
 * draws the same wall. Signature loops, scribbled words, crossings-out, circled bits, arrows and
 * stuck-on notes, as SVG paths, set as a CSS background (asyl.css --asyl-wall). Nothing is fetched.
 */

export const TILE = 900;

type Rnd = () => number;

const f = (n: number) => n.toFixed(1);

/** A cursive signature: a baseline with loops and a flourish. */
function signature(r: Rnd, x: number, y: number, w: number, h: number): string {
  const steps = 6 + Math.floor(r() * 8);
  let d = `M${f(x)} ${f(y)}`;
  let cx = x;
  for (let i = 0; i < steps; i++) {
    const dx = w / steps;
    const up = (r() * 0.9 + 0.4) * h * (r() < 0.25 ? 1.8 : 1);
    const loop = r() < 0.45;
    if (loop) {
      d += ` C${f(cx + dx * 0.9)} ${f(y - up)} ${f(cx - dx * 0.3)} ${f(y - up)} ${f(cx + dx * 0.4)} ${f(y + h * 0.15)}`;
    } else {
      d += ` Q${f(cx + dx * 0.5)} ${f(y - up)} ${f(cx + dx)} ${f(y + (r() - 0.3) * h * 0.4)}`;
    }
    cx += dx;
  }
  // The flourish under it, now and then.
  if (r() < 0.6)
    d += ` M${f(x - w * 0.05)} ${f(y + h * 0.5)} Q${f(x + w * 0.5)} ${f(y + h * (0.9 + r()))} ${f(x + w * 1.1)} ${f(y + h * 0.2)}`;
  return d;
}

/** A scribbled word: up-and-down strokes of uneven height. */
function word(r: Rnd, x: number, y: number, w: number, h: number): string {
  const letters = 3 + Math.floor(r() * 6);
  let d = "";
  let cx = x;
  for (let i = 0; i < letters; i++) {
    const lw = (w / letters) * (0.7 + r() * 0.5);
    const tall = h * (0.6 + r() * 0.8);
    const kind = r();
    if (kind < 0.35) d += ` M${f(cx)} ${f(y)} L${f(cx + lw * 0.5)} ${f(y - tall)} L${f(cx + lw)} ${f(y)}`;
    else if (kind < 0.6)
      d += ` M${f(cx + lw * 0.2)} ${f(y - tall)} L${f(cx + lw * 0.2)} ${f(y)} M${f(cx)} ${f(y - tall * 0.5)} L${f(cx + lw * 0.7)} ${f(y - tall * 0.5)}`;
    else if (kind < 0.8)
      d += ` M${f(cx + lw)} ${f(y - tall * 0.8)} C${f(cx - lw * 0.3)} ${f(y - tall)} ${f(cx - lw * 0.2)} ${f(y + h * 0.1)} ${f(cx + lw)} ${f(y - tall * 0.15)}`;
    else
      d += ` M${f(cx)} ${f(y - tall)} L${f(cx + lw * 0.3)} ${f(y)} L${f(cx + lw * 0.55)} ${f(y - tall * 0.6)} L${f(cx + lw * 0.8)} ${f(y)} L${f(cx + lw)} ${f(y - tall)}`;
    cx += lw * 1.15;
  }
  return d.trim();
}

function oval(r: Rnd, x: number, y: number, rx: number, ry: number): string {
  // Twice round, not quite closing, as a marker circles something.
  const t = r() * Math.PI;
  let d = "";
  for (let i = 0; i <= 28; i++) {
    const a = t + (i / 24) * Math.PI * 2;
    const k = 1 + (r() - 0.5) * 0.08;
    d += `${i ? " L" : "M"}${f(x + Math.cos(a) * rx * k)} ${f(y + Math.sin(a) * ry * k)}`;
  }
  return d;
}

function cross(r: Rnd, x: number, y: number, s: number): string {
  const j = () => (r() - 0.5) * s * 0.2;
  return `M${f(x - s + j())} ${f(y - s + j())} L${f(x + s + j())} ${f(y + s + j())} M${f(x + s + j())} ${f(y - s + j())} L${f(x - s + j())} ${f(y + s + j())}`;
}

function arrow(r: Rnd, x: number, y: number, len: number): string {
  const a = r() * Math.PI * 2;
  const ex = x + Math.cos(a) * len;
  const ey = y + Math.sin(a) * len;
  const bend = (r() - 0.5) * len * 0.6;
  const mx = (x + ex) / 2 - Math.sin(a) * bend;
  const my = (y + ey) / 2 + Math.cos(a) * bend;
  const h = len * 0.18;
  const back = a + Math.PI;
  return `M${f(x)} ${f(y)} Q${f(mx)} ${f(my)} ${f(ex)} ${f(ey)} M${f(ex + Math.cos(back - 0.5) * h)} ${f(ey + Math.sin(back - 0.5) * h)} L${f(ex)} ${f(ey)} L${f(ex + Math.cos(back + 0.5) * h)} ${f(ey + Math.sin(back + 0.5) * h)}`;
}

function star(r: Rnd, x: number, y: number, s: number): string {
  const t = r() * Math.PI;
  let d = "";
  for (let i = 0; i <= 5; i++) {
    const a = t + ((i * 2) / 5) * Math.PI * 2;
    d += `${i ? " L" : "M"}${f(x + Math.cos(a) * s)} ${f(y + Math.sin(a) * s)}`;
  }
  return d;
}

function heart(x: number, y: number, s: number): string {
  return `M${f(x)} ${f(y + s * 0.9)} C${f(x - s * 1.4)} ${f(y)} ${f(x - s * 0.7)} ${f(y - s * 1.1)} ${f(x)} ${f(y - s * 0.3)} C${f(x + s * 0.7)} ${f(y - s * 1.1)} ${f(x + s * 1.4)} ${f(y)} ${f(x)} ${f(y + s * 0.9)}`;
}

/** Dense crossed-out hatching, the wall's darkest patches. */
function hatch(r: Rnd, x: number, y: number, w: number, h: number): string {
  let d = "";
  const lines = 6 + Math.floor(r() * 8);
  for (let i = 0; i < lines; i++) {
    const y0 = y + r() * h;
    d += ` M${f(x + r() * w * 0.2)} ${f(y0)} L${f(x + w * (0.8 + r() * 0.2))} ${f(y0 + (r() - 0.5) * h * 0.6)}`;
  }
  return d.trim();
}

export interface WallOptions {
  /** The marker's colour and opacity. */
  ink: string;
  opacity: number;
  /** Stuck-on notes' fill; none when null. */
  note: string | null;
  seed?: number;
  /** Marks per tile. */
  density?: number;
}

/** One tile's marks: stroked paths and the notes' rectangles (centre, size, turn in degrees). */
export interface WallMarks {
  strokes: { d: string; width: number }[];
  notes: { x: number; y: number; w: number; h: number; rot: number }[];
}

export function wallMarks(opts: Pick<WallOptions, "seed" | "density"> & { notes: boolean }): WallMarks {
  const r = seeded(opts.seed ?? 2026_10_24);
  const notes: WallMarks["notes"] = [];
  const strokes: WallMarks["strokes"] = [];
  if (opts.notes) {
    for (let i = 0; i < 7; i++) {
      const w = 90 + r() * 120;
      const h = 50 + r() * 70;
      notes.push({ x: r() * (TILE - w), y: r() * (TILE - h), w, h, rot: (r() - 0.5) * 16 });
    }
  }
  const n = opts.density ?? 150;
  for (let i = 0; i < n; i++) {
    const x = r() * TILE;
    const y = r() * TILE;
    const k = r();
    const width = Number((1.2 + r() * 2.6).toFixed(1));
    let d: string;
    if (k < 0.28) d = signature(r, x, y, 60 + r() * 140, 10 + r() * 22);
    else if (k < 0.5) d = word(r, x, y, 40 + r() * 90, 10 + r() * 16);
    else if (k < 0.6) d = oval(r, x, y, 14 + r() * 40, 8 + r() * 24);
    else if (k < 0.68) d = cross(r, x, y, 6 + r() * 16);
    else if (k < 0.76) d = arrow(r, x, y, 30 + r() * 70);
    else if (k < 0.82) d = star(r, x, y, 6 + r() * 12);
    else if (k < 0.87) d = heart(x, y, 6 + r() * 10);
    else d = hatch(r, x, y, 30 + r() * 80, 10 + r() * 30);
    strokes.push({ d, width });
  }
  return { strokes, notes };
}

/** The tile as SVG markup. */
export function wallSvg(opts: WallOptions): string {
  const marks = wallMarks({ seed: opts.seed, density: opts.density, notes: !!opts.note });
  const notes = marks.notes.map(
    (n) =>
      `<rect x="${f(n.x)}" y="${f(n.y)}" width="${f(n.w)}" height="${f(n.h)}" transform="rotate(${f(n.rot)} ${f(n.x + n.w / 2)} ${f(n.y + n.h / 2)})"/>`,
  );
  const parts = marks.strokes.map((m) => `<path d="${m.d}" stroke-width="${m.width}"/>`);
  const noteGroup = opts.note ? `<g fill="${opts.note}">${notes.join("")}</g>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}" viewBox="0 0 ${TILE} ${TILE}">` +
    noteGroup +
    `<g fill="none" stroke="${opts.ink}" stroke-opacity="${opts.opacity}" stroke-linecap="round" stroke-linejoin="round">${parts.join("")}</g>` +
    `</svg>`
  );
}

/** The tile as a CSS url(), for a background. */
export function wallUrl(opts: WallOptions): string {
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(wallSvg(opts))}")`;
}

/**
 * Sets the two walls on the page: black marker on the orange wall around the map, and faint
 * orange marker on the dark map itself.
 */
export function paintWalls(root: HTMLElement = document.documentElement): void {
  root.style.setProperty(
    "--asyl-wall",
    wallUrl({ ink: "#120402", opacity: 0.62, note: "rgba(255, 214, 160, 0.16)" }),
  );
  root.style.setProperty(
    "--asyl-wall-dark",
    wallUrl({ ink: "#ff7a2f", opacity: 0.025, note: null, seed: 1985, density: 60 }),
  );
}
