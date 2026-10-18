import { useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { privyControls } from "../privyBridge";
import { askBefore, TwoFactorCancelled } from "../twoFactor";
import { useMe } from "../me";
import { CheckIcon, CopyIcon, WalletIcon } from "./Icons";
import { SETTINGS_WALLET_ID } from "./WalletMenu";

/**
 * Settings card for an account that signs in with Privy (email or Google/X): its wallet, funding
 * it, and exporting its key. Privy holds the key; this page never sees it (export happens in
 * Privy's own window). The address is shown only here, to its owner.
 */
export function PrivyWalletPanel({ compact = false }: { compact?: boolean }) {
  const me = useMe();
  // On the access screen the QR is up from the start: funding the wallet is the next step there.
  const [showQr, setShowQr] = useState(compact);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"fund" | "export" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const address = me?.walletAddress ?? "";
  const qr = useMemo(() => {
    if (!showQr || !address) return "";
    const q = qrcode(0, "M");
    q.addData(`solana:${address}`);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [showQr, address]);
  if (!me || me.signInMethod !== "privy") return null;

  const act = async (what: "fund" | "export") => {
    setBusy(what);
    setError(null);
    try {
      if (what === "export") await askBefore("export");
      const privy = await privyControls();
      if (what === "fund") await privy.addFunds(address);
      else await privy.exportWallet(address);
    } catch (e) {
      if (e instanceof TwoFactorCancelled) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Closing Privy's window is not an error.
      if (/exit|clos|cancel/i.test(msg)) return;
      setError(
        what === "fund"
          ? "Buying with a card isn't available right now. Send SOL to the address above from another wallet or an exchange instead."
          : msg,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className={compact ? "privy-wallet compact" : "panel privy-wallet"}
      id={compact ? undefined : SETTINGS_WALLET_ID}
    >
      {compact ? (
        <p className="small">
          <strong>Your wallet.</strong> Send SOL here from another wallet or an exchange (Solana network
          only), then buy $ASDFASDFA and burn it below.
        </p>
      ) : (
        <>
          <header className="section-head">
            <div>
              <span className="eyebrow">
                <WalletIcon size={13} /> Wallet
              </span>
              <h2>Your Privy wallet</h2>
            </div>
          </header>
          <p className="muted small">
            You signed in with email or a social account, so Privy keeps this Solana wallet for you. Send SOL
            to it from another wallet or an exchange (Solana network only), then buy $ASDFASDFA and burn it
            from the access screen. Only you see this address.
          </p>
        </>
      )}
      <div className="privy-address">
        <code className="num">{address}</code>
        <button
          className="ghost icon-btn"
          aria-label="Copy the address"
          onClick={() => void navigator.clipboard?.writeText(address).then(() => setCopied(true))}
        >
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        </button>
      </div>
      <div className="row-actions">
        <button className="button primary" disabled={busy !== null} onClick={() => void act("fund")}>
          {busy === "fund" ? "Opening…" : "Buy SOL with a card"}
        </button>
        <button className="button" onClick={() => setShowQr(!showQr)}>
          {showQr ? "Hide QR code" : "Show QR code"}
        </button>
        {/* Export never depends on access or on trading (user rule 2026-10-18). */}
        <button className="button ghost" disabled={busy !== null} onClick={() => void act("export")}>
          {busy === "export" ? "Opening…" : "Export key"}
        </button>
      </div>
      {showQr && (
        <div
          className="privy-qr"
          aria-label="QR code of your wallet address"
          dangerouslySetInnerHTML={{ __html: qr }}
        />
      )}
      {!compact && (
        <p className="faint small">
          Export shows your private key in Privy&apos;s window, never on this page. Anyone with it controls
          the wallet. This account is separate from any wallet sign-in: phone pairing by QR is for wallet
          sign-ins only, so on your phone, sign in with Privy again.
        </p>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
