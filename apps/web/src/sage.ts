import { useEffect, useState } from "react";

/**
 * Which token's TokenSage view is open. It lives in the address bar as `?sage=<mint>`, so the
 * view has a link of its own: Telegram alerts carry it (packages/core/src/telegram/format.ts,
 * sageUrl), and a page opened from one shows the view as soon as the feed is there, after a
 * sign-in if the browser needed one. A query parameter, not part of the hash, because the hash
 * names the tab.
 */

export const SAGE_PARAM = "sage";
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVENT = "sage:change";

/** The mint in the address bar, or null when none (or not a mint). */
export function sageFromUrl(search = window.location.search): string | null {
  const mint = new URLSearchParams(search).get(SAGE_PARAM);
  return mint && MINT_RE.test(mint) ? mint : null;
}

function write(mint: string | null) {
  const url = new URL(window.location.href);
  if (mint) url.searchParams.set(SAGE_PARAM, mint);
  else url.searchParams.delete(SAGE_PARAM);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(EVENT));
}

export function openSage(mint: string) {
  write(mint);
}

export function closeSage() {
  write(null);
}

/** The open view's mint, following openSage/closeSage and back/forward. */
export function useSageMint(): string | null {
  const [mint, setMint] = useState(sageFromUrl);
  useEffect(() => {
    const sync = () => setMint(sageFromUrl());
    window.addEventListener(EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);
  return mint;
}
