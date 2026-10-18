import { useEffect, useState } from "react";
import { ApiError, post, put } from "../api";
import { usePolling } from "../hooks";
import { shortAddress } from "../format";
import { Kpi, Load, Panel, Table, Tag, Wallet, n, when } from "./adminShared";

/** Mirrors apps/api/src/routes/adminCredits.ts GET /admin/credits. */
interface CreditsAdminView {
  prices: { tokensPerCredit: number; cost: { token: number; wallet: number } };
  totals: {
    wallets: number;
    burns: number;
    earned: number;
    granted: number;
    lookups: number;
    spent: number;
    dailyFreeUsed: number;
    outstanding: number;
  };
  recent: {
    wallet: string;
    delta: number;
    kind: "burn" | "spend" | "grant";
    burnSignature: string | null;
    rawAmount: string | null;
    utility: string | null;
    subject: string | null;
    note: string | null;
    source: "burned" | "granted" | "daily";
    createdAt: string;
  }[];
}

const errorText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/**
 * Burn Credits in the Admin tab: what a credit costs in $ASDFASDFA and what each utility charges
 * (both change for burns and lookups from then on), credits given by hand, and the ledger.
 */
export function CreditsAdmin() {
  const q = usePolling<CreditsAdminView>("/admin/credits", 60_000);
  return (
    <div className="stack">
      <Load q={q}>
        {(d) => (
          <div className="kpis">
            <Kpi label="Wallets" value={n(d.totals.wallets)} sub={`${n(d.totals.burns)} credit burns`} />
            <Kpi
              label="Credits earned"
              value={n(d.totals.earned)}
              sub={`${n(d.totals.granted)} granted by hand`}
            />
            <Kpi
              label="Credits spent"
              value={n(d.totals.spent)}
              sub={`${n(d.totals.lookups)} lookups, ${n(d.totals.dailyFreeUsed)} free daily`}
            />
            <Kpi label="Outstanding" value={n(d.totals.outstanding)} sub="unspent, all wallets" />
          </div>
        )}
      </Load>
      {q.data && <Prices prices={q.data.prices} onDone={q.reload} />}
      <Grant onDone={q.reload} />
      <Panel
        title="Credit ledger"
        note="Newest 50 rows. Burns add, lookups take (free daily credits first, then granted, then burned), grants either."
      >
        <Load q={q}>
          {(d) => (
            <Table
              head={["When", "Wallet", "Credits", "What", "Detail"]}
              rows={d.recent.map((r) => [
                when(r.createdAt),
                <Wallet address={r.wallet} />,
                <span className={`num ${r.delta >= 0 ? "up" : "down"}`}>
                  {r.delta >= 0 ? "+" : ""}
                  {n(r.delta)}
                </span>,
                r.kind === "burn" ? (
                  <Tag tone="ok">burn</Tag>
                ) : r.kind === "grant" ? (
                  <Tag tone="warn">grant</Tag>
                ) : (
                  `${r.utility ?? "?"} lookup${r.source === "burned" ? "" : `, ${r.source === "daily" ? "free daily" : "granted"}`}`
                ),
                r.burnSignature ? (
                  <a href={`https://solscan.io/tx/${r.burnSignature}`} target="_blank" rel="noreferrer">
                    {shortAddress(r.burnSignature)}
                  </a>
                ) : r.subject ? (
                  <span className="num">{shortAddress(r.subject)}</span>
                ) : (
                  (r.note ?? "–")
                ),
              ])}
            />
          )}
        </Load>
      </Panel>
    </div>
  );
}

/** The grant confirmation, naming the whole address: a short one can't show a mistyped middle. */
export function grantCreditsText(wallet: string, count: number): string {
  return count < 0
    ? `Take ${n(-count)} credits back from ${wallet}?`
    : `Award ${wallet} ${n(count)} Burn Credit${count === 1 ? "" : "s"}?`;
}

/** The Save prices confirmation: each setting as old → new, with the unchanged ones marked so. */
export function pricesChangeText(prices: CreditsAdminView["prices"], next: number[]): string {
  const rows: [string, number, number | undefined][] = [
    ["$ASDFASDFA per credit", prices.tokensPerCredit, next[0]],
    ["Token lookup", prices.cost.token, next[1]],
    ["Wallet lookup", prices.cost.wallet, next[2]],
  ];
  const lines = rows.map(([label, was, now]) => {
    const unit = label.startsWith("$") ? "" : " credits";
    return now === was
      ? `${label}: ${n(was)}${unit} (unchanged)`
      : `${label}: ${n(was)} → ${n(now ?? 0)}${unit}`;
  });
  const free = next[1] === 0 || next[2] === 0 ? "\n\nA cost of 0 makes that lookup free." : "";
  return `Change Burn Credit prices for everyone?\n\n${lines.join("\n")}${free}\n\nNew burns and lookups use these from now on.`;
}

function Prices({ prices, onDone }: { prices: CreditsAdminView["prices"]; onDone: () => void }) {
  const [ratio, setRatio] = useState(String(prices.tokensPerCredit));
  const [token, setToken] = useState(String(prices.cost.token));
  const [wallet, setWallet] = useState(String(prices.cost.wallet));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    setRatio(String(prices.tokensPerCredit));
    setToken(String(prices.cost.token));
    setWallet(String(prices.cost.wallet));
  }, [prices.tokensPerCredit, prices.cost.token, prices.cost.wallet]);
  const values = [Number(ratio), Number(token), Number(wallet)];
  const valid =
    values.every((v) => Number.isInteger(v) && v >= 0) && values[0]! >= 1 && values[0]! <= 1_000_000_000;
  const changed =
    values[0] !== prices.tokensPerCredit ||
    values[1] !== prices.cost.token ||
    values[2] !== prices.cost.wallet;
  const save = async () => {
    // One mistyped digit reprices every burn and lookup from now on, for everyone: show the change
    // side by side before it goes out.
    if (!window.confirm(pricesChangeText(prices, values))) return;
    setBusy(true);
    setResult(null);
    try {
      await put("/admin/credits/settings", {
        tokensPerCredit: values[0],
        cost: { token: values[1], wallet: values[2] },
      });
      setResult("Saved. New burns and lookups use these prices.");
      onDone();
    } catch (e) {
      setResult(`Failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="Prices"
      note="The ratio applies to burns credited after a change; credits already earned stay as they are."
    >
      <div className="admin-form">
        <label className="field">
          $ASDFASDFA per credit
          <input type="number" min={1} step={1} value={ratio} onChange={(e) => setRatio(e.target.value)} />
        </label>
        <label className="field">
          Token lookup (credits)
          <input type="number" min={0} step={1} value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <label className="field">
          Wallet lookup (credits)
          <input type="number" min={0} step={1} value={wallet} onChange={(e) => setWallet(e.target.value)} />
        </label>
        <button className="button primary" disabled={busy || !valid || !changed} onClick={() => void save()}>
          Save prices
        </button>
      </div>
      {result && <p className="small muted">{result}</p>}
    </Panel>
  );
}

function Grant({ onDone }: { onDone: () => void }) {
  const [wallet, setWallet] = useState("");
  const [credits, setCredits] = useState("10");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const count = Number(credits);
  const grant = async () => {
    if (!window.confirm(grantCreditsText(wallet.trim(), count))) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await post<{ balance: number }>("/admin/credits/grant", {
        wallet: wallet.trim(),
        delta: count,
        note: note.trim() || undefined,
      });
      setResult(`Done. ${shortAddress(wallet.trim())} now has ${n(r.balance)} credits.`);
      onDone();
    } catch (e) {
      setResult(`Failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="Award credits"
      note="Award Burn Credits to any wallet, yours included. Admins pay for lookups like everyone else, so this is how an admin wallet gets credits too. A negative number takes credits back, and every award is kept on the ledger."
    >
      <div className="admin-form">
        <input
          placeholder="Wallet address"
          aria-label="Wallet address"
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
        />
        <input
          className="admin-days"
          type="number"
          step={1}
          value={credits}
          onChange={(e) => setCredits(e.target.value)}
          aria-label="Credits"
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
          disabled={busy || !wallet.trim() || !Number.isInteger(count) || count === 0}
          onClick={() => void grant()}
        >
          {count < 0 ? `Take ${-count} credits` : `Award ${Number.isInteger(count) ? count : 0} credits`}
        </button>
      </div>
      {result && <p className="small muted">{result}</p>}
    </Panel>
  );
}
