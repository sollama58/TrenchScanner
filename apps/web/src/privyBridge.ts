import { useSyncExternalStore } from "react";
import { api } from "./api";

/**
 * Privy sign-in (email or Google/X, with a wallet Privy holds), the part in the main bundle.
 *
 * Privy's own code (privy.tsx) is a lazy chunk that only loads for someone choosing email sign-in
 * or already signed in with it: wallet users never download it. Once mounted it hands its few
 * actions to this module, so the sign-in screen and Settings can call them without importing it.
 */

export interface PrivyConfig {
  enabled: boolean;
  appId?: string;
  /** False at the sign-up cap: email sign-in is hidden for new accounts. */
  signupsOpen?: boolean;
  /** The in-app $ASDFASDFA buy is open (with Pro trading for everyone). */
  accessSwap?: boolean;
}

/** The name Privy's wallet registers under in the browser's wallet list (Wallet Standard). */
export const PRIVY_WALLET_NAME = "Privy";

let configPromise: Promise<PrivyConfig> | null = null;

/** GET /auth/privy/config, once per page; any failure reads as off. */
export function privyConfig(): Promise<PrivyConfig> {
  configPromise ??= api<PrivyConfig>("/auth/privy/config").catch(() => {
    configPromise = null;
    return { enabled: false };
  });
  return configPromise;
}

/** What privy.tsx can do, once Privy has loaded and is ready. */
export interface PrivyControls {
  /** Opens Privy's window; resolves with Privy's login token for /auth/privy. */
  login(): Promise<string>;
  /** Ends the Privy session too, so the next email sign-in asks again. */
  logout(): Promise<void>;
  /** Privy's own window for copying the wallet's private key (the key never reaches this page). */
  exportWallet(address: string): Promise<void>;
  /** Privy's funding window: card, exchange or another wallet, into this wallet as SOL. */
  addFunds(address: string): Promise<void>;
}

/** Closed Privy's window, or the login didn't finish. */
export class PrivyCancelled extends Error {}

let controls: PrivyControls | null = null;
let waiters: ((c: PrivyControls) => void)[] = [];
let wanted = false;
const listeners = new Set<() => void>();

export function setPrivyControls(c: PrivyControls | null): void {
  controls = c;
  if (c) {
    for (const w of waiters) w(c);
    waiters = [];
  }
}

/** Asks App to mount Privy (a no-op once it has). */
export function wantPrivy(): void {
  if (wanted) return;
  wanted = true;
  for (const l of listeners) l();
}

/** Whether Privy has been asked for on this page. */
export function usePrivyWanted(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => wanted,
  );
}

/** Privy's actions, loading it first if needed. Rejects when it doesn't come up in time. */
export function privyControls(timeoutMs = 20_000): Promise<PrivyControls> {
  if (controls) return Promise.resolve(controls);
  wantPrivy();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== done);
      reject(
        new Error("Privy didn't load. Check your connection, or relax a strict ad blocker for this site."),
      );
    }, timeoutMs);
    const done = (c: PrivyControls) => {
      clearTimeout(timer);
      resolve(c);
    };
    waiters.push(done);
  });
}

/** Privy's actions only if already loaded (sign-out uses this: no reason to load Privy just to leave). */
export function loadedPrivyControls(): PrivyControls | null {
  return controls;
}
