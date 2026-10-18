import { ApiError, api, downloadFile, post } from "./api";
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

/**
 * An admin request that may need the wallet's approval (the API's requireAdminConfirmation): sent
 * as it is first, and only when the API answers that it needs a signature (428, which a paired
 * phone never gets) asked of the wallet and sent again with it.
 */
export async function adminCall<T>(
  path: string,
  method: "POST" | "PUT",
  body: Record<string, unknown>,
): Promise<T> {
  try {
    return await api<T>(path, { method, body: JSON.stringify(body) });
  } catch (err) {
    if (!needsConfirmation(err)) throw err;
  }
  const { nonce, signature } = await signAdminChallenge(path, method, body);
  return api<T>(path, { method, body: JSON.stringify({ ...body, confirmation: { nonce, signature } }) });
}

/** A download the API may want approved: the same, with the signature in the query. */
export async function adminDownload(path: string, fallbackName: string): Promise<void> {
  try {
    return await downloadFile(path, fallbackName);
  } catch (err) {
    if (!needsConfirmation(err)) throw err;
  }
  const { nonce, signature } = await signAdminChallenge(path, "GET", {});
  const sep = path.includes("?") ? "&" : "?";
  return downloadFile(
    `${path}${sep}nonce=${encodeURIComponent(nonce)}&signature=${encodeURIComponent(signature)}`,
    fallbackName,
  );
}

function needsConfirmation(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 428 &&
    (err.body as { code?: unknown } | null)?.code === "confirmation_required"
  );
}

async function signAdminChallenge(
  path: string,
  method: "GET" | "POST" | "PUT",
  body: Record<string, unknown>,
) {
  const challenge = await post<{ nonce: string; message: string; walletAddress: string }>("/admin/confirm", {
    method,
    path: path.split("?")[0],
    body,
  });
  try {
    return {
      nonce: challenge.nonce,
      signature: await signMessageAs(challenge.walletAddress, challenge.message),
    };
  } catch (err) {
    throw new Error(describeConfirmError(err), { cause: err });
  }
}
