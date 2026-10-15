/**
 * Title tooltips for touch screens. Desktop browsers show an element's `title` on hover; phones and
 * tablets never do, so the explanations on stat tiles, labels and figures were out of reach there.
 * On a device without hover, a tap on a titled element that does nothing else (not a link, button,
 * field or anything else that acts on a tap) shows its title in a small bubble beside it. The next
 * tap anywhere, a scroll or a resize puts it away.
 *
 * Feed cards are left out: a tap on a card opens the token view, which carries the same tiles, and
 * there they are tappable.
 */

/** Anything a tap already does something on; its title stays a desktop hint. */
const ACTS_ON_TAP =
  "a, button, input, select, textarea, label, summary, [role='button'], [role='tab'], [role='switch'], [contenteditable], .card";

const NO_HOVER = "(hover: none)";

export function installTouchTips(doc: Document = document): () => void {
  const win = doc.defaultView;
  if (!win?.matchMedia) return () => undefined;
  let tip: HTMLDivElement | null = null;
  let owner: Element | null = null;

  const hide = () => {
    tip?.remove();
    tip = null;
    owner = null;
  };

  const show = (el: Element, text: string) => {
    hide();
    owner = el;
    tip = doc.createElement("div");
    tip.className = "touch-tip";
    tip.setAttribute("role", "tooltip");
    tip.textContent = text;
    // Inside an open dialog, so it draws above the dialog's top layer rather than behind it.
    (el.closest("dialog[open]") ?? doc.body).appendChild(tip);
    place(el, tip, win);
  };

  const onClick = (e: MouseEvent) => {
    if (!win.matchMedia(NO_HOVER).matches) return;
    const target = e.target instanceof Element ? e.target : null;
    const el = target?.closest("[title]");
    const text = el?.getAttribute("title")?.trim();
    if (!el || !text || el.closest(ACTS_ON_TAP)) {
      hide();
      return;
    }
    // A second tap on the same element puts its bubble away.
    if (owner === el) hide();
    else show(el, text);
  };

  doc.addEventListener("click", onClick, true);
  win.addEventListener("scroll", hide, { capture: true, passive: true });
  win.addEventListener("resize", hide);
  return () => {
    hide();
    doc.removeEventListener("click", onClick, true);
    win.removeEventListener("scroll", hide, { capture: true });
    win.removeEventListener("resize", hide);
  };
}

/** Above the element when there is room, else below it; kept inside the window either way. */
function place(el: Element, tip: HTMLElement, win: Window) {
  const r = el.getBoundingClientRect();
  const margin = 8;
  const vw = win.innerWidth;
  const w = Math.min(280, vw - margin * 2);
  tip.style.maxWidth = `${w}px`;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const left = Math.min(vw - margin - tw, Math.max(margin, r.left + r.width / 2 - tw / 2));
  const above = r.top - th - 6;
  const top = above >= margin ? above : r.bottom + 6;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}
