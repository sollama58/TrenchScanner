/**
 * Zooming into and moving around the bubble map (user ask 2026-10-18): the part of the map's own
 * box the view shows, kept inside that box. The share image always draws the whole map.
 */

export type MapBox = { x: number; y: number; w: number; h: number };
/** How far in (1 is the whole map) and the point at the middle of the view, in the map's units. */
export type MapZoom = { k: number; cx: number; cy: number };

export const MAX_MAP_ZOOM = 8;

/** The part of `box` a zoom shows: the whole box at none, else a k-times smaller box kept inside it. */
export function zoomedBox(box: MapBox, zoom: MapZoom | null): MapBox {
  if (!zoom || zoom.k <= 1) return box;
  const w = box.w / zoom.k;
  const h = box.h / zoom.k;
  return {
    x: Math.min(box.x + box.w - w, Math.max(box.x, zoom.cx - w / 2)),
    y: Math.min(box.y + box.h - h, Math.max(box.y, zoom.cy - h / 2)),
    w,
    h,
  };
}

/** A zoom whose view is `view`, kept inside `box`: null at the whole map. */
function zoomOf(box: MapBox, k: number, view: MapBox): MapZoom | null {
  if (k <= 1.001) return null;
  const kept = zoomedBox(box, { k, cx: view.x + view.w / 2, cy: view.y + view.h / 2 });
  return { k, cx: kept.x + kept.w / 2, cy: kept.y + kept.h / 2 };
}

/**
 * `zoom` taken `factor` times further in (below 1, out), the map's point `at` staying where it is
 * on screen; the view's middle when no point is given.
 */
export function zoomAround(
  box: MapBox,
  zoom: MapZoom | null,
  factor: number,
  at?: { x: number; y: number } | null,
): MapZoom | null {
  const k = zoom?.k ?? 1;
  const next = Math.min(MAX_MAP_ZOOM, Math.max(1, k * factor));
  const view = zoomedBox(box, zoom);
  const p = at ?? { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  const r = k / next;
  return zoomOf(box, next, {
    x: p.x - (p.x - view.x) * r,
    y: p.y - (p.y - view.y) * r,
    w: box.w / next,
    h: box.h / next,
  });
}

/** `zoom` moved by (dx, dy) in the map's units, kept inside `box`; nothing moves at the whole map. */
export function panZoom(box: MapBox, zoom: MapZoom | null, dx: number, dy: number): MapZoom | null {
  if (!zoom) return null;
  const view = zoomedBox(box, zoom);
  return zoomOf(box, zoom.k, { ...view, x: view.x + dx, y: view.y + dy });
}
