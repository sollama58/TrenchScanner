import { useEffect, useRef } from "react";
import { del, post, type ExtensionKeyCreated, type Subscription } from "./api";
import { findExtension, handOverKey } from "./extensionBridge";
import { shortAddress } from "./format";

/**
 * Reconnects the Trench Overlay extension without a click when the reader signs in again (user ask
 * 2026-10-24). Signing out revokes every extension key (audit CE-3), so the panel shows "Key
 * refused". If this browser's extension reports its key was refused and was connected to the
 * account now signed in, a new key goes straight to it. Nothing happens for another account, or
 * after the reader disconnected it in the panel (the extension then forgets the account). The key
 * only ever goes to the extension in the browser that just signed in, which a click in Settings
 * would do anyway, and only to a known build (the store or dev ID): an ID a link carried needs the
 * reader's click in Settings (audit EX-3).
 */
export async function reconnectExtension(
  walletAddress: string,
  deps: {
    create: () => Promise<ExtensionKeyCreated>;
    revoke: (id: string) => Promise<unknown>;
  } = {
    create: () => post<ExtensionKeyCreated>("/settings/extension-keys"),
    revoke: (id) => del(`/settings/extension-keys/${id}`),
  },
): Promise<boolean> {
  const found = await findExtension(null, { knownOnly: true });
  if (!found || found.connected || found.refusedAccount !== shortAddress(walletAddress)) return false;
  const created = await deps.create();
  const result = await handOverKey(found.id, created.secret, null, { knownOnly: true });
  if (!result.ok) await deps.revoke(created.id).catch(() => undefined);
  return result.ok;
}

/** Access the extension's keys need (the API's extensionKeyAccess). */
const KEY_ACCESS = new Set(["admin", "whitelist", "subscription"]);
/** Runs reconnectExtension once a signed-in account's access allows extension keys. */
export function useExtensionReconnect(walletAddress: string, access: Subscription["reason"] | undefined) {
  const allowed = access != null && KEY_ACCESS.has(access);
  // Once per sign-in: the subscription's re-reads every few minutes don't try again.
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (!allowed || tried.current === walletAddress) return;
    tried.current = walletAddress;
    void reconnectExtension(walletAddress).catch(() => undefined);
  }, [allowed, walletAddress]);
}
