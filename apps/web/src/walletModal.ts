import { useEffect, useState } from "react";

/**
 * The wallet modal's URL state: open as `?wallet=<address>` (like `?bubbles=`, bubbleMap.ts), so
 * a wallet has a link of its own and back closes it. Opened from any wallet the dashboard lists:
 * the token modal's flagged wallets, the bubble map, the admin wallet lists.
 */

export const WALLET_PARAM = "wallet";
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Fired on `window` when the open wallet changes (openWallet, closeWallet). */
export const WALLET_EVENT = "wallet:change";
const EVENT = WALLET_EVENT;

/** The wallet in the address bar, or null when none (or not an address). */
export function walletFromUrl(search = window.location.search): string | null {
  const wallet = new URLSearchParams(search).get(WALLET_PARAM);
  return wallet && ADDRESS_RE.test(wallet) ? wallet : null;
}

/** The modal's own link, for the Copy link button: this page with only `?wallet=<address>`. */
export function walletLink(wallet: string, href = window.location.href): string {
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  url.searchParams.set(WALLET_PARAM, wallet);
  return url.toString();
}

function write(wallet: string | null) {
  const url = new URL(window.location.href);
  if (wallet) url.searchParams.set(WALLET_PARAM, wallet);
  else url.searchParams.delete(WALLET_PARAM);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(EVENT));
}

export function openWallet(wallet: string) {
  if (ADDRESS_RE.test(wallet)) write(wallet);
}

export function closeWallet() {
  write(null);
}

/** The open wallet, following openWallet/closeWallet and back/forward. */
export function useWalletAddress(): string | null {
  const [wallet, setWallet] = useState(walletFromUrl);
  useEffect(() => {
    const sync = () => setWallet(walletFromUrl());
    window.addEventListener(EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);
  return wallet;
}

/** X's search for a wallet's address, sorted by Top (user ask 2026-10-14): who has posted it. */
export function xSearchLink(wallet: string): string {
  return `https://x.com/search?q=${encodeURIComponent(wallet)}&f=top`;
}

/** Outside links for a wallet: explorers and trackers that show it. */
export const WALLET_LINKS: { label: string; href: (w: string) => string }[] = [
  { label: "Solscan", href: (w) => `https://solscan.io/account/${w}` },
  { label: "GMGN", href: (w) => `https://gmgn.ai/sol/address/${w}` },
  { label: "KOLScan", href: (w) => `https://kolscan.io/account/${w}` },
  { label: "Birdeye", href: (w) => `https://birdeye.so/profile/${w}?chain=solana` },
  { label: "Explorer", href: (w) => `https://explorer.solana.com/address/${w}` },
];
