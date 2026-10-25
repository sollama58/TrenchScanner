/**
 * Where a row's badge goes: the first patch of empty space big enough for it, so it never sits
 * on the site's own text, numbers, icons or buttons (user ask 2026-10-23, the gap under Terminal's
 * market cap). Rectangles are in the row's own coordinates, 0,0 at its top-left.
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Room kept between the badge and anything it avoids, and from the row's edges. */
const GAP = 3;
const EDGE = 4;
const STEP = 4;

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
}

/**
 * The first free spot for a w×h badge, trying the right-hand side first, then moving left:
 * that's where the boards keep their numbers and their natural gaps, and it keeps the badge
 * clear of the token's picture and name on the left. Null when nothing fits.
 */
export function findSpot(
  row: { w: number; h: number },
  obstacles: readonly Box[],
  w: number,
  h: number,
): { x: number; y: number } | null {
  if (w + EDGE * 2 > row.w || h + EDGE * 2 > row.h) return null;
  const right = row.w - EDGE - w;
  for (let x = right; x >= EDGE; x -= STEP) {
    for (let y = EDGE; y + h <= row.h - EDGE; y += STEP) {
      const box = { x, y, w, h };
      if (!obstacles.some((o) => overlaps(box, o))) return { x, y };
    }
  }
  return null;
}

/** Elements that are content in their own right even with no text inside. */
const SOLID = "img, svg, canvas, video, button, input, select, textarea, [role='button'], [role='img']";

/**
 * What the badge must not cover: every visible run of text and every icon, picture or control in
 * the row, as boxes in the row's coordinates. Anything the size of most of the row is a background
 * and is left out. `skip` is the overlay's own element.
 */
export function obstaclesIn(row: HTMLElement, skip: Element): Box[] {
  const origin = row.getBoundingClientRect();
  const area = origin.width * origin.height;
  const boxes: Box[] = [];
  const add = (r: DOMRect) => {
    if (r.width < 1 || r.height < 1 || r.width * r.height > area * 0.5) return;
    boxes.push({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
  };
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || skip.contains(node)) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) add(r);
  }
  for (const el of row.querySelectorAll(SOLID)) {
    if (!skip.contains(el)) add(el.getBoundingClientRect());
  }
  return boxes;
}
