import { useState } from "react";
import { formatTokens } from "../burn";
import { del, post } from "../api";
import { usePolling } from "../hooks";
import { shortAddress } from "../format";
import { Load, Panel, Table, Tag, Wallet, when } from "./adminShared";

/**
 * Admin > Access > Pro Mode (apps/api/src/routes/adminProMode.ts): which wallets see the token
 * modal's Trade panel. Admins have it always, the top 250 $ASDFASDFA holders from the holder scan
 * (listed here by rank), and anyone else needs a grant here. PRO_TRADING_ENABLED off hides it from
 * everyone, admins included.
 */

interface ProModeReport {
  enabled: boolean;
  public?: boolean;
  admins: string[];
  holders: {
    scannedAt: string | null;
    /** The scans have stopped: everyone in the newest one is counting down a grace period. */
    stale?: boolean;
    inTop: number;
    /** In the newest scan, but not for its hour yet. */
    qualifying?: number;
    decimals?: number;
    /** The newest scan by rank; qualifiesAt null: Pro Mode now. */
    top?: {
      walletAddress: string;
      rank: number;
      heldRaw: string | null;
      qualifiesAt: string | null;
      signedUp: boolean;
    }[];
    grace: { walletAddress: string; rank: number; graceEndsAt: string; signedUp?: boolean }[];
  };
  grants: {
    walletAddress: string;
    note: string | null;
    grantedBy: string;
    createdAt: string;
    expiresAt: string | null;
    signedUp: boolean;
  }[];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProModeAdmin() {
  const q = usePolling<ProModeReport>("/admin/pro-mode", 60_000);
  const [wallet, setWallet] = useState("");
  const [note, setNote] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // The holder list: those with an account here by default, since only they see Pro Mode.
  const [allHolders, setAllHolders] = useState(false);

  const grant = async () => {
    const who = wallet.trim();
    const length = days.trim() ? Number(days.trim()) : undefined;
    if (length !== undefined && (!Number.isInteger(length) || length < 1 || length > 3650)) {
      setResult("Days must be a whole number from 1 to 3650, or empty for no end date.");
      return;
    }
    const until = length ? ` for ${length} day${length === 1 ? "" : "s"}` : " with no end date";
    if (
      !window.confirm(`Give ${shortAddress(who)} Pro Mode${until}? They can then trade from the token modal.`)
    )
      return;
    setBusy(true);
    setResult(null);
    try {
      await post("/admin/pro-mode", { walletAddress: who, note: note.trim() || undefined, days: length });
      setResult(`Pro Mode on for ${shortAddress(who)}.`);
      setWallet("");
      setNote("");
      setDays("");
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
      note="Pro Mode shows the Trade panel in the token modal: buy and sell with the wallet, no fee. Admins and the top 250 $ASDFASDFA holders have it automatically."
    >
      <Load q={q}>
        {(r) => (
          <>
            {!r.enabled && (
              <p className="small error">
                PRO_TRADING_ENABLED is off: no one sees the Trade panel, admins included.
              </p>
            )}
            {r.enabled && r.public === false && (
              <p className="small error">
                PRO_TRADING_PUBLIC is off: only admins see the Trade panel. Grants and holders below get it
                once it is on.
              </p>
            )}
            <p className="small muted">
              Top 250 $ASDFASDFA holders: {r.holders.inTop} wallets with Pro Mode
              {r.holders.qualifying ? `, ${r.holders.qualifying} still qualifying` : ""}
              {r.holders.scannedAt ? <>, last read {when(r.holders.scannedAt)}</> : ", not read yet"}. A new
              holder gets Pro Mode at the first scan that finds it in the top 250. Dropping out leaves 24
              hours of Pro Mode, with warnings, unless the wallet moved its bag away. After that it can&apos;t
              trade at all, sells included.
            </p>
            {r.holders.stale && (
              <p className="small error">
                The holder scan hasn&apos;t finished in over an hour: no one new gets Pro Mode, and the newest
                scan&apos;s wallets are counting down their grace. Check the pro-holders job in Health.
              </p>
            )}
            {r.holders.top && r.holders.top.length > 0 && (
              <>
                <label className="small admin-check">
                  <input
                    type="checkbox"
                    checked={allHolders}
                    onChange={(e) => setAllHolders(e.target.checked)}
                  />{" "}
                  Show all {r.holders.top.length}, not only wallets with an account here (
                  {r.holders.top.filter((h) => h.signedUp).length})
                </label>
                <Table
                  head={["Rank", "Holder", "Holds", "Pro Mode", ""]}
                  empty="No wallet in the top 250 has an account here yet."
                  rows={r.holders.top
                    .filter((h) => allHolders || h.signedUp)
                    .map((h) => [
                      `#${h.rank}`,
                      <Wallet address={h.walletAddress} />,
                      h.heldRaw && r.holders.decimals !== undefined
                        ? formatTokens(BigInt(h.heldRaw), r.holders.decimals).replace(/\.\d+$/, "")
                        : "–",
                      h.qualifiesAt === null ? (
                        <Tag tone="ok">on</Tag>
                      ) : (
                        <Tag tone="warn">
                          {Date.parse(h.qualifiesAt) > Date.now()
                            ? `from ${new Date(h.qualifiesAt).toLocaleTimeString()}`
                            : "next scan"}
                        </Tag>
                      ),
                      h.signedUp ? "" : <Tag tone="muted">no account</Tag>,
                    ])}
                />
              </>
            )}
            {r.holders.grace.length > 0 && (
              <Table
                head={["In grace", "Last rank", "Pro Mode ends", ""]}
                rows={r.holders.grace.map((g) => [
                  <Wallet address={g.walletAddress} />,
                  `#${g.rank}`,
                  new Date(g.graceEndsAt).toLocaleString(),
                  g.signedUp === false ? <Tag tone="muted">no account</Tag> : "",
                ])}
              />
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
              <input
                placeholder="Days (empty: no end)"
                aria-label="Days until it ends (optional)"
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value)}
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
              head={["Wallet", "Note", "Granted by", "Granted", "Ends", ""]}
              empty="No one besides the admins."
              rows={[
                ...r.admins.map((a) => [
                  <Wallet address={a} />,
                  <Tag tone="muted">admin</Tag>,
                  "–",
                  "always",
                  "–",
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
                  g.expiresAt ? (
                    new Date(g.expiresAt) > new Date() ? (
                      new Date(g.expiresAt).toLocaleString()
                    ) : (
                      <Tag tone="muted">ended</Tag>
                    )
                  ) : (
                    "never"
                  ),
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
