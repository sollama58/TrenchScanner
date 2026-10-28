import { useCallback, useEffect, useState } from "react";
import { api, ApiError, del, post } from "../api";
import { useSettings } from "../alerts";
import { linkSigners, type LinkSigner } from "../buddyWalletSign";
import { onWalletsChanged, WalletTimeoutError } from "../wallet";
import { GlobeIcon } from "./Icons";

interface BuddyWallet {
  wallet: string;
  createdAt: string;
}

/**
 * Settings, under the browser extension: the reader's other wallets (Axiom's, Terminal's...) that
 * Trade Buddy follows. Each is linked by signing a message with it in this browser (user decision
 * 2026-10-27, Card 11), so a key can only follow wallets its owner holds. Paid access, as the
 * extension is; a lapsed reader can still unlink.
 */
export function BuddyWalletsPanel() {
  const settings = useSettings();
  const level = settings?.account.access.level ?? null;
  if (level !== "admin" && level !== "whitelist" && level !== "subscription") return null;
  return <BuddyWalletsBody walletAddress={settings?.account.walletAddress ?? null} />;
}

const short = (wallet: string) => `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

function linkError(e: unknown, name: string): string {
  if (e instanceof WalletTimeoutError)
    return e.message === "connect"
      ? `${name} didn't answer. Open it from the toolbar, unlock it, then try again.`
      : `${name} didn't sign. Look for its popup, approve the message, then try again.`;
  if (e instanceof ApiError) {
    if (e.status === 401) return "The signature didn't verify. Try again with the same wallet.";
    if (e.status === 429) return "Too many wallets linked today. Try again tomorrow.";
    return e.message || `Linking failed (error ${e.status}).`;
  }
  const message = e instanceof Error ? e.message : String(e);
  if (/reject|denied|declin|cancel/i.test(message)) return "You cancelled in the wallet.";
  return message || `${name} stopped without saying why.`;
}

function BuddyWalletsBody({ walletAddress }: { walletAddress: string | null }) {
  const [wallets, setWallets] = useState<BuddyWallet[] | null>(null);
  const [limit, setLimit] = useState(3);
  const [signers, setSigners] = useState<LinkSigner[]>(linkSigners);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await api<{ wallets: BuddyWallet[]; limit: number }>("/settings/buddy-wallets");
      setWallets(body.wallets);
      setLimit(body.limit);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return onWalletsChanged(() => setSigners(linkSigners()));
  }, [load]);

  const link = (signer: LinkSigner) => {
    setBusy(signer.key);
    setError(null);
    let nonce = "";
    signer
      .sign(async (address) => {
        if (address === walletAddress)
          throw new Error(
            `${signer.name} shared the account's own wallet, which Trade Buddy follows already. Switch ${signer.name} to the other wallet, then try again.`,
          );
        const issued = await post<{ nonce: string; message: string }>("/settings/buddy-wallets/nonce", {
          wallet: address,
        });
        nonce = issued.nonce;
        return issued.message;
      })
      .then(({ address, signature }) =>
        post<{ wallets: string[] }>("/settings/buddy-wallets", { wallet: address, nonce, signature }),
      )
      .then(() => {
        setPicking(false);
        return load();
      })
      .catch((e: unknown) => setError(linkError(e, signer.name)))
      .finally(() => setBusy(null));
  };

  const unlink = (wallet: string) => {
    setBusy(wallet);
    setError(null);
    del(`/settings/buddy-wallets/${wallet}`)
      .then(() => setWallets((current) => current?.filter((w) => w.wallet !== wallet) ?? null))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const atCap = (wallets?.length ?? 0) >= limit;
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  return (
    <section className="panel" id="buddy-wallets">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <GlobeIcon size={13} /> Trench Overlay
          </span>
          <h2>Trade Buddy wallets</h2>
        </div>
        {!picking && (
          <button
            type="button"
            className="primary"
            disabled={atCap || busy !== null || wallets === null}
            onClick={() => setPicking(true)}
          >
            Link a wallet
          </button>
        )}
      </header>
      <p className="small muted">
        Trade Buddy follows your account's wallet, and up to {limit} other wallets of yours (Axiom's,
        Terminal's...) that you link here. To link one, open it in a wallet extension in this browser and sign
        a message with it. Signing costs nothing, sends no transaction, and doesn't sign you in.
      </p>
      {picking &&
        (signers.length === 0 ? (
          <p className="small">
            No wallet extension in this browser can sign messages. Import the wallet into Phantom, Solflare or
            Backpack, then try again.
          </p>
        ) : (
          <div className="mak-list">
            {signers.map((signer) => (
              <div className="mak-key" key={signer.key}>
                <div>{signer.name}</div>
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy !== null}
                  onClick={() => link(signer)}
                >
                  {busy === signer.key ? "Waiting for wallet…" : "Sign with it"}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="ghost small"
              disabled={busy !== null}
              onClick={() => setPicking(false)}
            >
              Cancel
            </button>
          </div>
        ))}
      {wallets === null ? (
        <p className="small muted">Loading wallets…</p>
      ) : wallets.length === 0 ? (
        <p className="small muted">No other wallets linked.</p>
      ) : (
        <div className="mak-list">
          {wallets.map((w) => (
            <div className="mak-key" key={w.wallet}>
              <div>
                <code className="num">{short(w.wallet)}</code>
                <div className="small muted">Linked {day(w.createdAt)}</div>
              </div>
              <button
                type="button"
                className="ghost small danger"
                disabled={busy !== null}
                onClick={() => unlink(w.wallet)}
              >
                Unlink
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
