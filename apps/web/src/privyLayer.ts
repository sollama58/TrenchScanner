/**
 * Keeps Privy's own window (its confirm-transaction and other prompts) usable over the site's popups.
 *
 * Every popup here is a modal <dialog> (showModal): it sits in the browser's top layer and makes the
 * rest of the page inert. Privy draws its window in a container it appends to <body>
 * (#headlessui-portal-root, from the Headless UI dialog it uses), so with a popup open - the Refill
 * Burn Credits popup, the Buy $ASDFASDFA popup, a token's trade panel - Privy's confirm window
 * opened underneath it, couldn't be clicked, and the burn or trade sat on "Approve in your wallet"
 * until it timed out. Moving that container into the open popup puts the window in the top layer
 * with it. Privy's window also marks the rest of the page inert while it is open (the app's
 * body-level wrapper, which now holds the popup and so the window itself); that one mark is lifted.
 */

export const PRIVY_PORTAL_ROOT_ID = "headlessui-portal-root";

/** The open modal popup that is on top, if any: the last open <dialog> in the page. */
export function topDialog(doc: Document): HTMLDialogElement | null {
  const open = doc.querySelectorAll<HTMLDialogElement>("dialog[open]");
  return open.length > 0 ? (open[open.length - 1] ?? null) : null;
}

/**
 * Puts Privy's window container where it can be seen and used: inside the top open popup, or back
 * on <body> when no popup is open. A no-op while Privy has no window up.
 */
export function placePrivyLayer(doc: Document): void {
  const root = doc.getElementById(PRIVY_PORTAL_ROOT_ID);
  if (!root) return;
  const top = topDialog(doc);
  const home: HTMLElement = top ?? doc.body;
  if (root.parentElement !== home) home.appendChild(root);
  if (!top) return;
  // The body-level element holding the popup (and now the window): Privy's window made it inert.
  let holder: HTMLElement = top;
  while (holder.parentElement && holder.parentElement !== doc.body) holder = holder.parentElement;
  if (holder !== top && holder.inert) holder.inert = false;
}

/** Keeps placePrivyLayer applied as Privy's window and the popups open and close. */
export function keepPrivyAboveDialogs(doc: Document = document): () => void {
  const place = () => placePrivyLayer(doc);
  // Privy's container arriving on <body> (body's own children only: the page below changes a lot).
  const arrivals = new MutationObserver(place);
  arrivals.observe(doc.body, { childList: true });
  // A popup opening or closing, and the inert mark.
  const marks = new MutationObserver(place);
  marks.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ["open", "inert"] });
  place();
  return () => {
    arrivals.disconnect();
    marks.disconnect();
  };
}
