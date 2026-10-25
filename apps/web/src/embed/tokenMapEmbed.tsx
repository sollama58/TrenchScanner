import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { API_URL } from "../api";
import { TokenMapView } from "../components/TokenMapView";
import { closeWallet, WALLET_EVENT, WALLET_PARAM, walletFromUrl } from "../walletModal";

/**
 * The site's bubble map for one coin, mounted outside the site: the browser extension's map page
 * (apps/extension/src/map/page.ts, user ask 2026-10-25) bundles this file, so the extension draws
 * the very map the token view does. The extension holds no site session: every API call the map
 * makes is handed to `request`, which the extension answers through its own key. Nothing here
 * reads or writes the site's session, and no call leaves for any other host.
 */

/** One API call of the map's, as `api()` would have sent it. */
export interface SiteCall {
  method: string;
  /** The API path and query, e.g. `/tokens/<mint>/card`. */
  path: string;
  body: string | null;
}

/** The answer to a SiteCall: the status and the JSON text, as the API sent them. */
export interface SiteAnswer {
  status: number;
  body: string;
}

export type SiteRequest = (call: SiteCall) => Promise<SiteAnswer>;

/** Puts the map for `mint` in `root`, its API calls answered by `request`. Returns its unmount. */
export function mountTokenMap(root: HTMLElement, mint: string, request: SiteRequest): () => void {
  routeFetch(request);
  openWalletsOnSite();
  const react = createRoot(root);
  react.render(
    <StrictMode>
      <TokenMapView mint={mint} />
    </StrictMode>,
  );
  return () => react.unmount();
}

let walletsOnSite = false;

/**
 * A wallet the map opens (a bubble, a cluster's list) opens on TrenchScanner in a new tab: there is
 * no wallet view here, and openWallet only marks the address bar (walletModal.ts).
 */
function openWalletsOnSite(): void {
  if (walletsOnSite) return;
  walletsOnSite = true;
  window.addEventListener(WALLET_EVENT, () => {
    const wallet = walletFromUrl();
    if (!wallet) return;
    closeWallet();
    window.open(`https://trenchscanner.app/?${WALLET_PARAM}=${wallet}`, "_blank", "noopener,noreferrer");
  });
}

/** The API calls `api()` makes go to `request`; anything else is refused. */
function routeFetch(request: SiteRequest): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${API_URL}/`)) throw new TypeError("Only TrenchScanner's API is reachable here");
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const body = typeof init?.body === "string" ? init.body : null;
    const answer = request({
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.slice(API_URL.length),
      body,
    });
    const aborted = new Promise<never>((_, reject) =>
      signal?.addEventListener(
        "abort",
        () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        {
          once: true,
        },
      ),
    );
    const a = await Promise.race([answer, aborted]);
    return new Response(a.status === 204 ? null : a.body, {
      status: a.status,
      headers: { "content-type": "application/json" },
    });
  };
}
