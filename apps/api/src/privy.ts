import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { isWalletAddress, type Env } from "@trenchscanner/core";

/**
 * Privy sign-in (user decision 2026-10-18): someone signs in with email or Google/X in Privy's
 * window and Privy makes them a Solana wallet. The dashboard hands us Privy's login token; we
 * check it against the app's verification key, then ask Privy's API (with the app secret) for the
 * account's wallet. The browser never tells us which wallet: a token for one account can't be
 * turned into a session for any other wallet.
 */

export function privyEnabled(env: Env): boolean {
  return Boolean(env.PRIVY_APP_ID && env.PRIVY_APP_SECRET && env.PRIVY_JWKS_ENDPOINT);
}

/**
 * Privy's signing keys, from PRIVY_JWKS_ENDPOINT. jose caches them, fetches again when a token
 * names a key it hasn't seen (Privy rotating), and refetches at most every 30 seconds, so a flood
 * of made-up key ids can't turn into a flood of requests to Privy.
 */
let jwks: { url: string; keys: ReturnType<typeof createRemoteJWKSet> } | null = null;

/** Stand-ins for Privy's keys and API, for tests only (privy.test.ts). */
export const privyTestDoubles: { keys: JWTVerifyGetKey | null; fetch: typeof fetch | null } = {
  keys: null,
  fetch: null,
};

function verificationKeys(env: Env): JWTVerifyGetKey {
  if (privyTestDoubles.keys) return privyTestDoubles.keys;
  if (jwks?.url !== env.PRIVY_JWKS_ENDPOINT)
    jwks = {
      url: env.PRIVY_JWKS_ENDPOINT,
      keys: createRemoteJWKSet(new URL(env.PRIVY_JWKS_ENDPOINT), {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      }),
    };
  return jwks.keys;
}

/** The Privy account (DID) a login token belongs to, or null when the token isn't good. */
export async function verifyPrivyToken(env: Env, accessToken: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(accessToken, verificationKeys(env), {
      issuer: "privy.io",
      audience: env.PRIVY_APP_ID,
      algorithms: ["ES256"],
    });
    return typeof payload.sub === "string" && payload.sub.startsWith("did:privy:") ? payload.sub : null;
  } catch (err) {
    // Privy's keys out of reach (a timeout or a failed fetch) is an outage, not a bad token.
    // jose's own failures name what was wrong with the token; the generic one is a bad key fetch.
    const code = (err as { code?: unknown } | null)?.code;
    if (
      err instanceof errors.JWKSTimeout ||
      code === "ERR_JOSE_GENERIC" ||
      err instanceof TypeError ||
      (typeof code === "string" && /^E[A-Z]+$/.test(code))
    )
      throw new PrivyUnavailable(err instanceof Error ? err.message : "Privy's keys are out of reach");
    return null;
  }
}

export class PrivyUnavailable extends Error {}

/** One of a Privy account's linked accounts, as Privy's API returns it (snake_case). */
interface LinkedAccount {
  type?: string;
  address?: string;
  chain_type?: string;
  wallet_client_type?: string;
  connector_type?: string;
}

/**
 * The Solana wallet Privy made for the account, from Privy's API. Only an embedded wallet
 * ("privy" client) counts: a wallet the user merely linked in Privy's window is one they hold
 * themselves, and signs in through wallet sign-in instead. Null when it has none yet.
 */
export async function privyEmbeddedSolanaWallet(
  env: Env,
  did: string,
  fetchImpl: typeof fetch = privyTestDoubles.fetch ?? fetch,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.privy.io/v1/users/${encodeURIComponent(did)}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${env.PRIVY_APP_ID}:${env.PRIVY_APP_SECRET}`).toString("base64")}`,
        "privy-app-id": env.PRIVY_APP_ID,
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new PrivyUnavailable("couldn't reach Privy");
  }
  if (!res.ok) throw new PrivyUnavailable(`Privy answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as {
    id?: string;
    linked_accounts?: LinkedAccount[];
  } | null;
  if (!body || body.id !== did) throw new PrivyUnavailable("Privy's answer was for another account");
  const wallets = (body.linked_accounts ?? []).filter(
    (a) =>
      a.type === "wallet" &&
      a.chain_type === "solana" &&
      a.wallet_client_type === "privy" &&
      typeof a.address === "string" &&
      isWalletAddress(a.address),
  );
  // Privy makes one Solana wallet per account; more than one would leave "which" a guess.
  return wallets.length === 1 ? wallets[0]!.address! : null;
}
