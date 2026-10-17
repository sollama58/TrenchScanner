import { useState } from "react";
import { del, post } from "../api";
import { usePolling } from "../hooks";
import { shortAddress } from "../format";
import { Load, Panel, Table, Tag, Wallet, when } from "./adminShared";

/**
 * Admin > Access > Pro Mode (apps/api/src/routes/adminProMode.ts): which wallets see the token
 * modal's Trade panel. Admins have it always; anyone else needs a grant here. PRO_TRADING_ENABLED
 * off hides it from everyone, admins included.
 */

interface ProModeReport {
  enabled: boolean;
  admins: string[];
  grants: {
    walletAddress: string;
    note: string | null;
    grantedBy: string;
    createdAt: string;
    signedUp: boolean;
  }[];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProModeAdmin() {
  const q = usePolling<ProModeReport>("/admin/pro-mode", 60_000);
  const [wallet, setWallet] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const grant = async () => {
    const who = wallet.trim();
    if (!window.confirm(`Give ${shortAddress(who)} Pro Mode? They can then trade from the token modal.`))
      return;
    setBusy(true);
    setResult(null);
    try {
      await post("/admin/pro-mode", { walletAddress: who, note: note.trim() || undefined });
      setResult(`Pro Mode on for ${shortAddress(who)}.`);
      setWallet("");
      setNote("");
      q.reload();
    } catch (e) {
      setResult(`Failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (address: string) => {
    if (!window.confirm(`Take Pro Mode away from ${shortAddress(address)}?`)) return;
    try {
      await del(`/admin/pro-mode/${encodeURIComponent(address)}`);
      q.reload();
    } catch (e) {
      window.alert(errorText(e));
    }
  };

  return (
    <Panel
      title="Pro Mode"
      note="Pro Mode shows the Trade panel in the token modal: buy and sell with the wallet, no fee. Admins have it always."
    >
      <Load q={q}>
        {(r) => (
          <>
            {!r.enabled && (
              <p className="small error">
                PRO_TRADING_ENABLED is off: no one sees the Trade panel, admins included.
              </p>
            )}
            <div className="admin-form">
              <input
                placeholder="Wallet address"
                aria-label="Wallet address"
                value={wallet}
                onChange={(e) => setWallet(e.target.value)}
              />
              <input
                placeholder="Note (optional)"
                aria-label="Note (optional)"
                maxLength={200}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="button primary"
                disabled={busy || !wallet.trim()}
                onClick={() => void grant()}
              >
                Give Pro Mode
              </button>
            </div>
            {result && <p className="small muted">{result}</p>}
            <Table
              head={["Wallet", "Note", "Granted by", "Granted", ""]}
              empty="No one besides the admins."
              rows={[
                ...r.admins.map((a) => [
                  <Wallet address={a} />,
                  <Tag tone="muted">admin</Tag>,
                  "–",
                  "always",
                  "",
                ]),
                ...r.grants.map((g) => [
                  <Wallet address={g.walletAddress} />,
                  <>
                    {g.note ?? "–"}
                    {!g.signedUp && (
                      <>
                        {" "}
                        <Tag tone="muted">not signed up yet</Tag>
                      </>
                    )}
                  </>,
                  shortAddress(g.grantedBy),
                  when(g.createdAt),
                  <button className="ghost small" onClick={() => void remove(g.walletAddress)}>
                    Remove
                  </button>,
                ]),
              ]}
            />
          </>
        )}
      </Load>
    </Panel>
  );
}
