import { useSyncExternalStore } from "react";
import { api, ApiError, post } from "./api";

/**
 * Two-factor on the dashboard (user decision 2026-10-18): optional, by authenticator app or
 * passkey, and the user picks which actions ask for it.
 *
 * The API asks for it on what it can stop (sign-in, trades, phone pairing) by answering 403 with
 * `twoFactor`; withTwoFactor shows the prompt and retries with the pass it gives. Burns and
 * exports never pass through the API before the wallet signs, so the dashboard asks before those
 * itself (askBefore).
 */

export type TwoFactorAction = "signin" | "buy" | "buyOver" | "sell" | "burn" | "pair" | "export" | "manage";

/** What the user can pick; export always asks once two-factor is on. */
export const ACTION_CHOICES: { id: Exclude<TwoFactorAction, "manage">; label: string }[] = [
  { id: "signin", label: "Signing in on a new browser" },
  { id: "buy", label: "Every buy" },
  { id: "buyOver", label: "Buys over a size I set" },
  { id: "sell", label: "Every sell" },
  { id: "burn", label: "Burning $ASDFASDFA" },
  { id: "pair", label: "Pairing a phone" },
  { id: "export", label: "Exporting the wallet key (always)" },
];

/** A second factor, as the API's /verify and /2fa/signin take it. */
export type SecondFactor =
  { code: string } | { backupCode: string } | { passkey: { token: string; response: unknown } };

/** Which factors the account has, so the prompt offers only those. */
export interface FactorHint {
  totp: boolean;
  passkey: boolean;
}

/** The 403 the API answers when an action needs a pass. */
export function twoFactorNeeded(e: unknown): { action: TwoFactorAction; hint?: FactorHint } | null {
  if (!(e instanceof ApiError) || e.status !== 403) return null;
  const t = (e.body as { twoFactor?: { action?: unknown; totp?: unknown; passkey?: unknown } } | null)
    ?.twoFactor;
  if (!t || typeof t.action !== "string") return null;
  // Without the factors in the answer, passFor reads them from /auth/2fa.
  const hint =
    typeof t.totp === "boolean" && typeof t.passkey === "boolean"
      ? { totp: t.totp, passkey: t.passkey }
      : undefined;
  return { action: t.action as TwoFactorAction, hint };
}

// ---- The prompt (TwoFactorPrompt.tsx draws it) ----

export interface PromptRequest {
  /** Unique per ask. */
  id: number;
  title: string;
  hint: FactorHint;
  /** Passkey options from the API, when the user picks a passkey. */
  passkeyOptions: () => Promise<{ options: unknown; token: string }>;
  /** Checks a factor; throws (with a message to show) when it doesn't match. */
  submit: (factor: SecondFactor) => Promise<void>;
  done: (ok: boolean) => void;
}

let open: PromptRequest | null = null;
const listeners = new Set<() => void>();
function setOpen(r: PromptRequest | null) {
  open = r;
  for (const l of listeners) l();
}

/** The prompt now open, if any (the hook below, outside React). */
export function promptRequest(): PromptRequest | null {
  return open;
}

export function usePromptRequest(): PromptRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}

/** The user closed the prompt without finishing. */
export class TwoFactorCancelled extends Error {
  constructor() {
    super("Two-factor check cancelled.");
  }
}

/** Shows the prompt until a factor passes `submit` (resolving) or the user closes it (rejecting). */
let nextId = 1;

export function askSecondFactor(req: Omit<PromptRequest, "done" | "id">): Promise<void> {
  return new Promise((resolve, reject) => {
    // One prompt at a time: a second ask cancels the first.
    open?.done(false);
    const id = nextId++;
    setOpen({
      ...req,
      id,
      done: (ok) => {
        // Only this ask's own prompt: a late close from an older one leaves a newer one up.
        if (open?.id === id) setOpen(null);
        if (ok) resolve();
        else reject(new TwoFactorCancelled());
      },
    });
  });
}

// ---- Passes for one action ----

const PASS_REUSE_MS = 4 * 60_000;
const passes = new Map<TwoFactorAction, { pass: string; at: number }>();

const TITLES: Record<TwoFactorAction, string> = {
  signin: "Confirm it's you to sign in",
  buy: "Confirm this buy",
  buyOver: "Confirm this buy",
  sell: "Confirm this sell",
  burn: "Confirm this burn",
  pair: "Confirm pairing a phone",
  export: "Confirm exporting your wallet key",
  manage: "Confirm changing two-factor",
};

/** A pass for `action` (from the last few minutes, or asked for now). */
export async function passFor(action: TwoFactorAction, hint?: FactorHint): Promise<string> {
  const kept = passes.get(action);
  if (kept && Date.now() - kept.at < PASS_REUSE_MS) return kept.pass;
  let factors: FactorHint;
  if (hint) factors = hint;
  else {
    const state = await api<{ totp: boolean; passkeys: unknown[] }>("/auth/2fa");
    factors = { totp: state.totp, passkey: state.passkeys.length > 0 };
  }
  let pass = "";
  await askSecondFactor({
    title: TITLES[action],
    hint: factors,
    passkeyOptions: () => post("/auth/2fa/passkey-options"),
    submit: async (factor) => {
      pass = (await post<{ pass: string }>("/auth/2fa/verify", { action, ...factor })).pass;
    },
  });
  passes.set(action, { pass, at: Date.now() });
  return pass;
}

/** Forgets every pass (on sign-out). */
export function clearPasses(): void {
  passes.clear();
}

/**
 * Runs an API call, and when the API asks for two-factor, prompts and runs it again with the
 * pass. `call` gets the headers to send (empty the first time).
 */
export async function withTwoFactor<T>(call: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  try {
    return await call({});
  } catch (e) {
    const needed = twoFactorNeeded(e);
    if (!needed) throw e;
    passes.delete(needed.action);
    const pass = await passFor(needed.action, needed.hint);
    return call({ "x-ts-2fa": pass });
  }
}

/** POST with withTwoFactor. */
export function postWithTwoFactor<T>(path: string, body?: unknown): Promise<T> {
  return withTwoFactor((headers) =>
    api<T>(path, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
}

/** What the signed-in user's choices are, as /auth/me reports them. */
export interface UserTwoFactor {
  enabled: boolean;
  actions: string[];
  buyOverLamports: string | null;
}

/**
 * For the actions the API can't stop (burns, exports): asks here first when the user's choices
 * say so. Resolves when it may go ahead; rejects with TwoFactorCancelled when the user backs out.
 */
export async function askBefore(action: "burn" | "export", tf: UserTwoFactor | undefined): Promise<void> {
  if (!tf?.enabled) return;
  if (action !== "export" && !tf.actions.includes(action)) return;
  await passFor(action);
}
