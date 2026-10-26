import { CARD_H, CARD_W, cardCanvas, clip } from "../shareCard";
import {
  ANALYST,
  analystLayout,
  analystScene,
  analystView,
  boxColour,
  boxesOf,
  captionColour,
  linkStyle,
  sceneBounds,
  type AnalystScene,
} from "./analyst";
import type { AsylGraph } from "./graph";
import type { LayoutState } from "./layout";

/**
 * Analyst Mode's share image: the flowchart as the reader sees it, on its near-black page, with
 * its key in the corner and Asyl's name small at the top, in the style investigators post.
 */

export interface AnalystCardInput {
  title: string;
  graph: AsylGraph;
  layout?: LayoutState;
  focus: string | null;
  solUsd?: number | null;
  /** What is on screen now: the image is that view. Absent, the whole map fits the card. */
  view?: { x: number; y: number; k: number; w: number; h: number };
}

type Pos = ReadonlyMap<string, { x: number; y: number }>;

export async function renderAnalystCard(input: AnalystCardInput): Promise<HTMLCanvasElement> {
  const shot = input.view;
  const W = shot ? Math.max(320, Math.round(shot.w)) : CARD_W;
  const H = shot ? Math.max(240, Math.round(shot.h)) : CARD_H;
  const sc = shot ? Math.max(1, Math.min(2, 4096 / Math.max(W, H))) : 2;
  const { canvas: cardC } = await cardCanvas(1);
  const canvas = shot ? document.createElement("canvas") : cardC;
  canvas.width = Math.round(W * sc);
  canvas.height = Math.round(H * sc);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.scale(sc, sc);
  await document.fonts?.load(`500 16px ${ANALYST.font}`).catch(() => undefined);

  const v = analystView(input.graph, input.focus);
  const boxes = boxesOf(v, input.focus);
  // The screen's own places when it has every box; a fresh flowchart otherwise.
  let pos: Pos = input.layout?.pos ?? new Map();
  if (v.graph.nodes.some((n) => !pos.has(n.id))) pos = analystLayout(v.graph, boxes);
  const scene = analystScene(v, boxes, pos, input.solUsd ?? null);

  ctx.fillStyle = ANALYST.page;
  ctx.fillRect(0, 0, W, H);
  const top = shot ? 0 : 56;
  let t: { k: number; x: number; y: number };
  if (shot) t = { k: shot.k, x: shot.x, y: shot.y };
  else {
    const b = sceneBounds(scene, pos);
    const room = { x: 40, y: top + 16, w: W - 80, h: H - top - 40 };
    const k = Math.min(1.6, room.w / Math.max(1, b.maxX - b.minX), room.h / Math.max(1, b.maxY - b.minY));
    t = {
      k,
      x: room.x + (room.w - (b.maxX - b.minX) * k) / 2 - b.minX * k,
      y: room.y + (room.h - (b.maxY - b.minY) * k) / 2 - b.minY * k,
    };
  }
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.scale(t.k, t.k);
  drawScene(ctx, scene, pos);
  ctx.restore();

  // Asyl's name and the map's title, small at the top; the key in the bottom corner.
  ctx.font = `600 13px ${ANALYST.font}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#ff7a2f";
  ctx.fillText("ASYL", 18, 28);
  ctx.fillStyle = ANALYST.muted;
  ctx.fillText(clip(ctx, `· ${input.title}`, W * 0.6), 62, 28);
  ctx.textAlign = "right";
  ctx.fillText("asyl.trenchscanner.app", W - 18, 28);
  drawKey(ctx, scene, W, H);
  return canvas;
}

function drawScene(ctx: CanvasRenderingContext2D, scene: AnalystScene, pos: Pos) {
  ctx.lineJoin = "miter";
  for (const f of scene.frames) {
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = ANALYST.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(f.x, f.y, f.w, f.h);
  }
  for (const r of scene.routes) {
    const st = linkStyle(r.edge);
    ctx.setLineDash(st.dash ? st.dash.split(" ").map(Number) : []);
    ctx.strokeStyle = st.colour;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    r.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    if (st.arrow && r.points.length > 1) {
      const [x1, y1] = r.points[r.points.length - 2]!;
      const [x2, y2] = r.points[r.points.length - 1]!;
      const a = Math.atan2(y2 - y1, x2 - x1);
      ctx.setLineDash([]);
      ctx.fillStyle = st.colour;
      ctx.save();
      ctx.translate(x2, y2);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-9, -4.5);
      ctx.lineTo(-6.4, 0);
      ctx.lineTo(-9, 4.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.setLineDash([]);
  ctx.font = `500 11.5px ${ANALYST.font}`;
  for (const r of scene.routes) {
    ctx.textAlign = r.anchor === "middle" ? "center" : r.anchor === "end" ? "right" : "left";
    ctx.lineWidth = 4;
    ctx.strokeStyle = ANALYST.page;
    ctx.strokeText(r.text, r.tx, r.ty);
    ctx.fillStyle = ANALYST.ink;
    ctx.fillText(r.text, r.tx, r.ty);
  }
  for (const b of scene.boxes.values()) {
    const p = pos.get(b.id);
    if (!p) continue;
    ctx.textAlign = "center";
    if (b.role === "service") {
      ctx.beginPath();
      ctx.arc(p.x, p.y, b.w / 2, 0, Math.PI * 2);
      ctx.fillStyle = ANALYST.page;
      ctx.fill();
      ctx.strokeStyle = ANALYST.ink;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = ANALYST.ink;
      ctx.font = `500 14px ${ANALYST.font}`;
      ctx.fillText("S", p.x, p.y + 5);
    } else {
      ctx.fillStyle = ANALYST.page;
      ctx.fillRect(p.x - b.w / 2, p.y - b.h / 2, b.w, b.h);
      ctx.strokeStyle = boxColour(b);
      ctx.lineWidth = b.focus ? 3 : 2.4;
      ctx.strokeRect(p.x - b.w / 2, p.y - b.h / 2, b.w, b.h);
      ctx.fillStyle = b.role === "group" ? ANALYST.group : ANALYST.ink;
      const one = b.lines.length === 1;
      ctx.font = `500 ${one ? 16 : 13}px ${ANALYST.font}`;
      b.lines.forEach((line, i) =>
        ctx.fillText(line, p.x, p.y + (i - (b.lines.length - 1) / 2) * 17 + (one ? 5.5 : 4.5)),
      );
    }
    if (b.caption) {
      const service = b.role === "service";
      ctx.font = `500 ${service ? 11 : 13.5}px ${ANALYST.font}`;
      const text = b.caption.length > 26 ? `${b.caption.slice(0, 25)}…` : b.caption;
      const y = service ? p.y + b.h / 2 + 15 : p.y - b.h / 2 - 9;
      ctx.lineWidth = 4;
      ctx.strokeStyle = ANALYST.page;
      ctx.strokeText(text, p.x, y);
      ctx.fillStyle = captionColour(b);
      ctx.fillText(text, p.x, y);
    }
  }
}

/** The key, as on screen: only what the picture uses. */
function drawKey(ctx: CanvasRenderingContext2D, scene: AnalystScene, W: number, H: number) {
  const roles = new Set([...scene.boxes.values()].map((b) => b.role));
  const kinds = new Set(scene.routes.map((r) => r.edge.kind));
  const rows: { draw: (x: number, y: number) => void; text: string }[] = [];
  const box = (c: string) => (x: number, y: number) => {
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(x, y - 7, 26, 12);
  };
  const line = (c: string, dash: number[]) => (x: number, y: number) => {
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x, y - 1);
    ctx.lineTo(x + 26, y - 1);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (roles.has("group")) rows.push({ draw: box(ANALYST.group), text: "Trader groups" });
  if (roles.has("dev")) rows.push({ draw: box(ANALYST.dev), text: "Dev wallets" });
  if (kinds.has("funded") || kinds.has("transfer"))
    rows.push({ draw: line(ANALYST.ink, []), text: "Funding and transfers" });
  if (kinds.has("cotrade")) rows.push({ draw: line(ANALYST.ink, [5, 4]), text: "Time/size connection" });
  if (roles.has("service"))
    rows.push({
      draw: (x, y) => {
        ctx.strokeStyle = ANALYST.ink;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(x + 13, y - 1, 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = ANALYST.ink;
        ctx.font = `500 10px ${ANALYST.font}`;
        ctx.textAlign = "center";
        ctx.fillText("S", x + 13, y + 2.5);
      },
      text: "Service/Exchange",
    });
  if (scene.frames.length)
    rows.push({
      draw: (x, y) => {
        ctx.strokeStyle = ANALYST.ink;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x + 2, y - 8, 22, 14);
        ctx.setLineDash([]);
      },
      text: "Grouped wallets",
    });
  if (!rows.length) return;
  const x0 = W - 230;
  let y = H - 18 - (rows.length - 1) * 24;
  ctx.fillStyle = "rgba(11, 11, 12, 0.85)";
  ctx.fillRect(x0 - 12, y - 20, 236, rows.length * 24 + 14);
  for (const r of rows) {
    r.draw(x0, y);
    ctx.textAlign = "left";
    ctx.font = `500 13px ${ANALYST.font}`;
    ctx.fillStyle = ANALYST.ink;
    ctx.fillText(r.text, x0 + 38, y + 4);
    y += 24;
  }
}
