/**
 * Where rings, pills and safety marks may go (user ask 2026-10-28): the boards' columns, the
 * Trending lists and the sites' full search menus. A coin row in a quick search dropdown, a
 * tooltip, a hover card or any other popover is left bare, as are the lists on a coin's own page
 * (its trades, its dev's other coins); the column marks (Axiom's Pulse, Terminal's Trenches) are
 * the one exception there, and the adapter names them.
 *
 * A row's scope comes from the layers around it. A layer is anything floating over the page: a
 * tooltip, popover, menu or dialog by its role or its library's wrapper, or a box taken out of the
 * flow (fixed, or absolute straight under the body, as portals are) smaller than half the screen.
 * A layer is a search menu when it holds its own search box and is the size of a panel; a quick
 * search's dropdown hangs under a box that sits outside it, in the header.
 */
export type Scope = "page" | "search" | "off";

/** Floating text tied to one element: never a search menu, whatever is inside. */
const TIP = [
  "[role='tooltip']",
  "[data-tippy-root]",
  "[data-radix-popper-content-wrapper]",
  ".ant-tooltip",
  ".ant-popover",
  ".MuiTooltip-popper",
].join(", ");

/** Menus, popovers and dialogs by role or library: a layer, a search menu only by its contents. */
const LAYER = [
  "[role='dialog']",
  "[role='alertdialog']",
  "[aria-modal='true']",
  "[role='menu']",
  "[role='listbox']",
  "[popover]",
  "[data-floating-ui-portal]",
  "[data-headlessui-portal]",
  ".ant-dropdown",
  ".ant-select-dropdown",
  ".ant-modal",
  ".MuiPopover-root",
  ".MuiPopper-root",
  ".chakra-popover__popper",
  ".chakra-modal__content",
].join(", ");

const SEARCH_BOX = "input:not([type]), input[type='text'], input[type='search']";

/** A full search menu is at least this big; a dropdown under a header box is smaller, or holds no box. */
const SEARCH_MIN_W = 400;
const SEARCH_MIN_H = 300;

function outOfFlow(el: Element): boolean {
  const position = getComputedStyle(el).position;
  if (position !== "fixed" && !(position === "absolute" && el.parentElement === el.ownerDocument.body))
    return false;
  // A fixed shell or panel holding most of the screen (the app, a board under a fixed header) is
  // the page itself; what floats over it is smaller.
  const r = el.getBoundingClientRect();
  return r.width * r.height < window.innerWidth * window.innerHeight * 0.5;
}

function isSearchMenu(layer: Element): boolean {
  if (!layer.querySelector(SEARCH_BOX)) return false;
  const r = layer.getBoundingClientRect();
  return r.width >= SEARCH_MIN_W && r.height >= SEARCH_MIN_H;
}

/**
 * The scope of each row's surroundings, worked out once per element per scan: rows share most of
 * their ancestors, so a fresh `Scoper` for each scan asks the layout about each box once.
 */
export class Scoper {
  private readonly memo = new Map<Element, Scope>();

  of(el: Element | null): Scope {
    if (!el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement) return "page";
    const known = this.memo.get(el);
    if (known) return known;
    const outer = this.of(el.parentElement);
    let scope = outer;
    if (outer !== "off") {
      if (el.matches(TIP)) scope = "off";
      else if (el.matches(LAYER) || outOfFlow(el))
        scope = outer === "search" || isSearchMenu(el) ? "search" : "off";
    }
    this.memo.set(el, scope);
    return scope;
  }
}
