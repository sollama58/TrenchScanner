import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import bs58 from "bs58";
import { api, ApiError, post } from "./api";
import { buildBurnTransaction, toBase64 } from "./burnTx";
import { shortAddress } from "./format";
import { solanaWallets, withTimeout, WalletTimeoutError } from "./wallet";

/**
 * Burning $ASDFASDFA for access, from the dashboard.
 *
 * Rides the same path as a burn made anywhere else: the wallet signs a plain SPL burn, the API
 * relays it (/subscription/send), and /subscription/claim credits it once it finalises - which the
 * burn reconciler would also do on its own if this tab closed halfway. Nothing here decides access;
 * it only builds the transaction and asks.
 */

/** GET /subscription/balance. Amounts are base units as decimal strings (u64s, never floats). */
export interface BurnBalance {
  mint: string;
  decimals: number;
  tokenProgram: string;
  totalRaw: string;
  /** Accounts a burn can come from, largest first. */
  accounts: { address: string; rawAmount: string }[];
}

/** A wallet in this browser that can sign the burn. */
export interface BurnWallet {
  key: string;
  name: string;
  icon?: string;
  wallet: Wallet;
}

/**
 * Wallet Standard wallets that can sign a transaction. The older window.solana-style providers
 * aren't offered: their signTransaction wants a web3.js object, and every current wallet that
 * injects one also registers on the standard.
 */
export function burnWallets(): BurnWallet[] {
  return solanaWallets()
    .filter((w) => SolanaSignTransaction in w.features || SolanaSignAndSendTransaction in w.features)
    .map((w, i) => ({ key: `std:${w.name}:${i}`, name: w.name, icon: w.icon, wallet: w }));
}

// ---- A burn sent but not yet credited, kept across reloads ----

const PENDING_KEY = "ts-pending-burn";
/** The reconciler credits a landed burn within minutes; past this the note is only clutter. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingBurn {
  signature: string;
  wallet: string;
  months: number;
  at: number;
}

/**
 * The burn this wallet sent from this browser that hasn't been confirmed yet. Kept so a reload
 * mid-burn goes back to checking on it instead of offering a fresh burn button - the moment a
 * second, unintended burn is most likely.
 */
export function readPendingBurn(wallet: string): PendingBurn | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingBurn>;
    if (
      typeof p.signature !== "string" ||
      p.wallet !== wallet ||
      typeof p.at !== "number" ||
      Date.now() - p.at > PENDING_TTL_MS
    )
      return null;
    return { signature: p.signature, wallet, months: Number(p.months) || 0, at: p.at };
  } catch {
    return null;
  }
}

function savePendingBurn(p: PendingBurn): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    // Blocked storage: the burn is still tracked for as long as this page stays open.
  }
}

export function clearPendingBurn(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing was kept.
  }
}

// ---- Sending ----

/** The relay's reply was lost: the burn may have gone out. Carries its signature to keep checking. */
export class BurnUncertainError extends Error {
  constructor(
    message: string,
    readonly signature: string,
  ) {
    super(message);
  }
}

export interface BurnRequest {
  wallet: BurnWallet;
  /** The signed-in wallet. The burn must come from it, or the months go to someone else. */
  owner: string;
  tokenAccount: string;
  mint: string;
  decimals: number;
  rawAmount: bigint;
  months: number;
  /** Called as the burn moves along, for the button's label. */
  onStage?: (stage: "connecting" | "preparing" | "signing" | "sending") => void;
}

async function accountFor(wallet: BurnWallet, owner: string): Promise<WalletAccount> {
  const connect = (wallet.wallet.features as Partial<StandardConnectFeature>)[StandardConnect];
  if (!connect) throw new Error(`${wallet.name} can't connect`);
  const { accounts } = await withTimeout(connect.connect(), "connect");
  const account =
    accounts.find((a) => a.address === owner) ?? wallet.wallet.accounts.find((a) => a.address === owner);
  if (!account) {
    const other = accounts[0]?.address;
    throw new Error(
      `${wallet.name} is on ${other ? `a different account (${shortAddress(other)})` : "no account"}. ` +
        `Switch it to ${shortAddress(owner)}, the wallet you signed in with, and try again. Nothing was burned.`,
    );
  }
  return account;
}

/**
 * Has the wallet sign the burn and gets it onto the chain. Resolves with the transaction's
 * signature once it has been sent; crediting is a separate step (claimBurn).
 */
export async function sendBurn(req: BurnRequest): Promise<string> {
  req.onStage?.("connecting");
  const account = await accountFor(req.wallet, req.owner);

  // Fetched last thing before signing: a blockhash lasts about a minute, and this doubles as the
  // check that the API is up before anything irreversible happens.
  req.onStage?.("preparing");
  const { blockhash } = await api<{ blockhash: string }>("/subscription/blockhash");
  const transaction = buildBurnTransaction({
    owner: req.owner,
    tokenAccount: req.tokenAccount,
    mint: req.mint,
    decimals: req.decimals,
    rawAmount: req.rawAmount,
    blockhash,
  });

  const features = req.wallet.wallet.features as Partial<SolanaSignTransactionFeature> &
    Partial<SolanaSignAndSendTransactionFeature>;
  const pending = (signature: string) =>
    savePendingBurn({ signature, wallet: req.owner, months: req.months, at: Date.now() });

  const signer = features[SolanaSignTransaction];
  if (signer) {
    // Sign here, relay through the API. A timeout on this step is safe: a signature that arrives
    // after it is thrown away and never sent.
    req.onStage?.("signing");
    const [signed] = await withTimeout(
      signer.signTransaction({ account, transaction, chain: "solana:mainnet" }),
      "sign",
    );
    if (!signed?.signedTransaction) throw new Error(`${req.wallet.name} returned no signed transaction`);
    const bytes = Uint8Array.from(signed.signedTransaction);
    // The transaction's id is its first signature (one signer, so right after the count byte).
    // Noted before sending, so even a tab that dies mid-request comes back to check on it.
    const signature = bytes[0] === 1 && bytes.length > 65 ? bs58.encode(bytes.slice(1, 65)) : null;
    if (signature) pending(signature);

    req.onStage?.("sending");
    try {
      const sent = await post<{ signature: string }>("/subscription/send", { transaction: toBase64(bytes) });
      pending(sent.signature);
      return sent.signature;
    } catch (e) {
      const lost =
        e instanceof ApiError &&
        typeof (e.body as { signature?: unknown } | null)?.signature === "string" &&
        (e.body as { signature: string }).signature;
      if (lost) {
        pending(lost);
        throw new BurnUncertainError(e.message, lost);
      }
      // The API's own refusal (a JSON error and no signature) means nothing went out. Anything
      // else - a dropped connection, a proxy's error page - may have come after the relay.
      const refused =
        e instanceof ApiError && typeof (e.body as { error?: unknown } | null)?.error === "string";
      if (refused) clearPendingBurn();
      else if (signature) throw new BurnUncertainError(networkLost, signature);
      throw e;
    }
  }

  const sender = features[SolanaSignAndSendTransaction];
  if (!sender) throw new Error(`${req.wallet.name} can't sign transactions`);
  // The wallet sends it itself. No timeout here: approving after one would still burn, and the
  // page would already have said it failed.
  req.onStage?.("signing");
  const [sent] = await sender.signAndSendTransaction({ account, transaction, chain: "solana:mainnet" });
  if (!sent?.signature) throw new Error(`${req.wallet.name} returned no signature`);
  const signature = bs58.encode(Uint8Array.from(sent.signature));
  pending(signature);
  return signature;
}

const networkLost =
  "We lost the connection while sending. Check your wallet before trying again - if it went through, your access arrives on its own.";

// ---- Crediting ----

export type ClaimResult =
  | { status: "credited"; expiresAt: string | null }
  | { status: "pending"; message?: string }
  | { status: "held"; message: string }
  | { status: "rejected"; message: string };

/**
 * Asks the API to credit a burn. "pending" covers both "not finalised yet" and "couldn't ask right
 * now": the caller keeps checking either way, and the reconciler credits a landed burn regardless.
 */
export async function claimBurn(signature: string): Promise<ClaimResult> {
  try {
    const r = await post<{ status: string; expiresAt?: string | null; message?: string }>(
      "/subscription/claim",
      { signature },
    );
    if (r.status === "pending") return { status: "pending", message: r.message };
    if (r.status === "held")
      return { status: "held", message: r.message ?? "That burn belongs to another wallet." };
    return { status: "credited", expiresAt: r.expiresAt ?? null };
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      const body = e.body as { error?: unknown } | null;
      return { status: "rejected", message: typeof body?.error === "string" ? body.error : e.message };
    }
    return { status: "pending" };
  }
}

/** A plain-language reason a burn didn't start, never an empty or bare technical one. */
export function describeBurnError(e: unknown, walletName: string): string {
  if (e instanceof WalletTimeoutError)
    return e.message === "connect"
      ? `${walletName} didn't answer. Its popup may be hidden behind this window, or it may be locked. Nothing was burned.`
      : `${walletName} didn't sign in time, so nothing was sent and nothing was burned. Try again when you're ready.`;
  if (e instanceof ApiError) {
    if (e.status === 429) return "Too many tries. Wait a minute, then try again. Nothing was burned.";
    return e.message || `The server answered ${e.status}. Nothing was burned.`;
  }
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (code === 4001 || /reject|denied|declin|cancel/i.test(message))
    return "You cancelled in the wallet. Nothing was burned.";
  if (e instanceof TypeError && /fetch|network|load failed/i.test(message))
    return "Couldn't reach the TrenchScanner server. Nothing was burned. Check your connection and try again.";
  if (message) return message;
  return `${walletName} stopped without saying why. Nothing was burned.`;
}

// ---- Amounts ----

/** Base units to a whole-token string with thousands separators and up to 2 decimals. */
export function formatTokens(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const cents = ((raw % unit) * 100n) / unit;
  const w = whole.toLocaleString("en-US");
  return cents === 0n ? w : `${w}.${cents.toString().padStart(2, "0").replace(/0$/, "")}`;
}
