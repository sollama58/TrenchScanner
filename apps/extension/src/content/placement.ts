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
  /** A picture or icon, which a badge may sit on when no clear patch is left; never text or a control. */
  soft?: boolean;
}

/**
 * How much room a badge asks for: the space kept from what it avoids (`gap`) and from the row's
 * edges (`edge`), and whether pictures count (`soft`). A badge tries the roomy fit first, then
 * the tight one, then sits on a picture rather than ever on the row's numbers (user ask
 * 2026-11-21: on a packed Terminal card the badge fell back to the top-right corner, over the
 * market cap).
 */
export interface Room {
  gap: number;
  edge: number;
  soft: boolean;
}
export const ROOMY: Room = { gap: 3, edge: 4, soft: true };
export const TIGHT: Room = { gap: 1, edge: 1, soft: true };
export const ON_PICTURES: Room = { gap: 1, edge: 1, soft: false };
const STEP = 4;

function overlaps(a: Box, b: Box, gap: number): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

function clear(box: Box, obstacles: readonly Box[], room: Room): boolean {
  return !obstacles.some((o) => (room.soft || !o.soft) && overlaps(box, o, room.gap));
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
  room: Room = ROOMY,
): { x: number; y: number } | null {
  const { edge } = room;
  if (w + edge * 2 > row.w || h + edge * 2 > row.h) return null;
  const right = row.w - edge - w;
  for (let x = right; x >= edge; x -= STEP) {
    for (let y = edge; y + h <= row.h - edge; y += STEP) {
      if (clear({ x, y, w, h }, obstacles, room)) return { x, y };
    }
  }
  return null;
}

/** The box is still inside the row and clear of every obstacle: a placed badge can stay put. */
export function stillFits(
  row: { w: number; h: number },
  obstacles: readonly Box[],
  box: Box,
  room: Room = ROOMY,
): boolean {
  const { edge } = room;
  if (box.x < edge || box.y < edge || box.x + box.w > row.w - edge || box.y + box.h > row.h - edge)
    return false;
  return clear(box, obstacles, room);
}

/** Elements that are content in their own right even with no text inside. */
const SOLID = "img, svg, canvas, video, button, input, select, textarea, [role='button'], [role='img']";
/** Of those, the pictures: a badge may sit on one as a last resort, never on a control. */
const PICTURE = "img, svg, canvas, video, [role='img']";
const CONTROL = "button, [role='button']";

/**
 * What the badge must not cover: every visible run of text and every icon, picture or control in
 * the row, as boxes in the row's coordinates, pictures marked soft. Anything the size of most of
 * the row is a background and is left out. `skip` is the overlay's own element.
 */
export function obstaclesIn(row: HTMLElement, skip: Element, origin = row.getBoundingClientRect()): Box[] {
  const area = origin.width * origin.height;
  const boxes: Box[] = [];
  const add = (r: DOMRect, soft = false) => {
    if (r.width < 1 || r.height < 1 || r.width * r.height > area * 0.5) return;
    const box: Box = { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
    if (soft) box.soft = true;
    boxes.push(box);
  };
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || skip.contains(node)) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) add(r);
  }
  for (const el of row.querySelectorAll(SOLID)) {
    if (skip.contains(el)) continue;
    // An icon inside a button is the button's: the button's own box stays hard. A row that is
    // itself clickable as a whole doesn't count as that button.
    const control = el.parentElement?.closest(CONTROL);
    add(
      el.getBoundingClientRect(),
      el.matches(PICTURE) && !(control && control !== row && row.contains(control)),
    );
  }
  return boxes;
}
