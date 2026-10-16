import { api, post } from "./api";
import { signMessageAs, WalletTimeoutError } from "./wallet";

/**
 * A trading bot request approved by the signed-in wallet (the API's tradeConfirm.ts). Asks the API
 * for the text that names this exact request, has the wallet sign it, and sends the request with
 * the signature. Every settings save, sell, withdrawal, wallet creation and trade-alert change goes
 * through here; paper trading doesn't.
 */
export async function confirmedTradingCall<T>(
  path: string,
  method: "POST" | "PUT",
  body: Record<string, unknown> = {},
): Promise<T> {
  const challenge = await post<{ nonce: string; message: string; walletAddress: string }>(
    "/trading/confirm",
    {
      method,
      path,
      body,
    },
  );
  let signature: string;
  try {
    signature = await signMessageAs(challenge.walletAddress, challenge.message);
  } catch (err) {
    throw new Error(describeConfirmError(err), { cause: err });
  }
  return api<T>(path, {
    method,
    body: JSON.stringify({ ...body, confirmation: { nonce: challenge.nonce, signature } }),
  });
}

/** Why the wallet didn't approve, in plain words. */
export function describeConfirmError(err: unknown): string {
  if (err instanceof WalletTimeoutError)
    return "Your wallet didn't answer. Look for its popup (it may be behind this window), approve the message, then try again.";
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (code === 4001 || /reject|denied|declin|cancel/i.test(message))
    return "You cancelled in the wallet, so nothing changed.";
  return message || "Your wallet didn't sign, so nothing changed. Unlock it and try again.";
}
