import { useEffect, useMemo, useRef } from "react";
import { getWallets } from "@wallet-standard/app";
import {
  PrivyProvider,
  useDepositFunds,
  useLogin,
  useMfaEnrollment,
  usePrivy,
  type PrivyClientConfig,
} from "@privy-io/react-auth";
import {
  useExportWallet,
  useSignTransaction,
  useStandardWallets,
  useWallets,
} from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import {
  PRIVY_WALLET_NAME,
  PrivyCancelled,
  privyOAuthReturn,
  rememberPlace,
  setPrivyControls,
} from "./privyBridge";
import { keepPrivyAboveDialogs } from "./privyLayer";

/**
 * Privy's half of email sign-in: a lazy chunk (see privyBridge.ts), mounted once someone picks
 * email sign-in or is already signed in with it. It renders nothing of its own; Privy draws its
 * windows itself.
 *
 * Privy's wallet joins the browser's wallet list (the Wallet Standard registry wallet.ts reads),
 * so burns and Pro trades sign with it the same way they sign with Phantom: nothing else in the
 * app needs to know which kind of wallet it is.
 */

/** Solana's public RPC: Privy only reads with it here. Trades and burns are sent by the API. */
const RPC = "https://api.mainnet-beta.solana.com";
const RPC_WS = "wss://api.mainnet-beta.solana.com";

/** Solana mainnet (CAIP-2), as Privy's funding window names it; SOL by its alias. */
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** How long a sign-in waits for Privy to finish a Google or X return before giving up. */
const OAUTH_RETURN_WAIT_MS = 30_000;
/** This page load came back from Google or X, and Privy hasn't finished that sign-in yet. */
let oauthReturning = privyOAuthReturn();

export default function PrivyRoot({ appId }: { appId: string }) {
  const config = useMemo<PrivyClientConfig>(
    () => ({
      loginMethods: ["email", "google", "twitter"],
      appearance: { theme: "dark", walletChainType: "solana-only", showWalletLoginFirst: false },
      embeddedWallets: {
        // Privy's confirm window on every signature by default (user decision 2026-10-18, after the
        // wallet security audit): burns, and anything the site didn't build, always ask. A Pro trade
        // skips it only on a coin the wallet holds, that passed the safety screen, or that a model
        // called (the API's `quietSign`), and only once the page's own check passed (signQuietly).
        showWalletUIs: true,
        solana: { createOnLogin: "all-users" },
        ethereum: { createOnLogin: "off" },
      },
      solana: {
        rpcs: {
          "solana:mainnet": {
            rpc: createSolanaRpc(RPC),
            rpcSubscriptions: createSolanaRpcSubscriptions(RPC_WS),
          },
        },
      },
    }),
    [],
  );
  return (
    <PrivyProvider appId={appId} config={config}>
      <Bridge />
    </PrivyProvider>
  );
}

function Bridge() {
  const { ready, authenticated, getAccessToken, logout, user, mfaMethods } = usePrivy();
  const { showMfaEnrollmentModal } = useMfaEnrollment();
  const { exportWallet } = useExportWallet();
  const { depositFunds } = useDepositFunds();
  const { wallets } = useStandardWallets();
  const { wallets: connected } = useWallets();
  const { signTransaction } = useSignTransaction();
  const pending = useRef<{ resolve: (t: string) => void; reject: (e: unknown) => void } | null>(null);

  const finish = async () => {
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    try {
      const token = await getAccessToken();
      if (token) p.resolve(token);
      else p.reject(new PrivyCancelled("Privy didn't finish signing you in. Try again."));
    } catch (e) {
      p.reject(e);
    }
  };
  const { login } = useLogin({
    onComplete: () => {
      oauthReturning = false;
      void finish();
    },
    onError: (err) => {
      oauthReturning = false;
      pending.current?.reject(new PrivyCancelled(err === "exited_auth_flow" ? "cancelled" : String(err)));
      pending.current = null;
    },
  });

  // The latest of each in a ref, so the controls handed out once keep working across renders.
  const latest = useRef({
    authenticated,
    login,
    logout,
    exportWallet,
    depositFunds,
    getAccessToken,
    connected,
    signTransaction,
    user,
    mfaMethods,
    showMfaEnrollmentModal,
  });
  latest.current = {
    authenticated,
    login,
    logout,
    exportWallet,
    depositFunds,
    getAccessToken,
    connected,
    signTransaction,
    user,
    mfaMethods,
    showMfaEnrollmentModal,
  };

  useEffect(() => {
    if (!ready) return;
    setPrivyControls({
      login: () =>
        new Promise<string>((resolve, reject) => {
          pending.current?.reject(new PrivyCancelled("cancelled"));
          pending.current = { resolve, reject };
          // Back from Google or X: Privy is finishing that sign-in on its own (a new account's
          // wallet is made first), and onComplete or onError settles this. Checked before
          // `authenticated`, which is already true while the wallet is still being made.
          if (oauthReturning) {
            setTimeout(() => {
              if (pending.current?.resolve !== resolve) return;
              oauthReturning = false;
              pending.current = null;
              reject(new PrivyCancelled("Google or X didn't finish signing you in. Try again."));
            }, OAUTH_RETURN_WAIT_MS);
            return;
          }
          // Always Privy's window, never a Privy session left in this browser: that may be the
          // wrong Google account, or someone else's on a shared computer.
          void (async () => {
            if (latest.current.authenticated) await latest.current.logout().catch(() => undefined);
            // Google and X come back to the address this starts from, and Privy only takes the
            // exact ones on its dashboard list (a 401 "Redirect URL is not allowed" otherwise).
            rememberPlace();
            latest.current.login();
          })();
        }),
      logout: () => latest.current.logout(),
      exportWallet: (address) => latest.current.exportWallet({ address }),
      mfa: () => ({
        available: latest.current.mfaMethods.length > 0,
        enrolled: (latest.current.user?.mfaMethods.length ?? 0) > 0,
      }),
      enrollMfa: () => latest.current.showMfaEnrollmentModal(),
      signQuietly: async (address, transaction) => {
        const wallet = latest.current.connected.find((w) => w.address === address);
        if (!wallet) throw new Error("Privy's wallet isn't ready yet. Try again in a moment.");
        const { signedTransaction } = await latest.current.signTransaction({
          transaction,
          wallet,
          chain: "solana:mainnet",
          options: { uiOptions: { showWalletUIs: false } },
        });
        return signedTransaction;
      },
      addFunds: async (address) => {
        // Card or bank, through Privy's onramp. Crypto deposits stay off: people send SOL from
        // another wallet or exchange straight to the address the dashboard shows.
        await latest.current.depositFunds({
          destination: { asset: "sol", chain: SOLANA_MAINNET, wallet: address },
          fiat: {},
        });
      },
    });
    return () => setPrivyControls(null);
  }, [ready]);

  // Privy's confirm window over the site's popups (the Refill and Buy popups, a token's trade panel).
  useEffect(() => keepPrivyAboveDialogs(), []);

  // Privy's own wallet into the browser's wallet list, once per wallet object.
  useEffect(() => {
    const privy = wallets.filter((w) => w.name === PRIVY_WALLET_NAME);
    if (privy.length === 0) return;
    const registry = getWallets();
    const already = new Set(registry.get());
    const fresh = privy.filter((w) => !already.has(w));
    if (fresh.length === 0) return;
    return registry.register(...fresh);
  }, [wallets]);

  return null;
}
