import { useRef, useState } from "react";
import { shortAddress } from "../format";
import { openWallet } from "../walletModal";
import { labelExport, MAX_IMPORT_BYTES, parseLabelImport } from "../trackedImport";
import {
  importTrackedWallets,
  removeTrackedWallet,
  saveTrackedWallet,
  trackedError,
  useTrackedWallets,
  type TrackedWallet,
} from "../trackedWallets";

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A label's form: its name and whether it shows with the KOLs (else as User Tracked). Saves on
 * submit; `onDone` after a save, a removal or Cancel.
 */
function LabelForm({
  wallet,
  current,
  nameMax,
  onDone,
}: {
  wallet: string;
  current: TrackedWallet | undefined;
  nameMax: number;
  onDone: () => void;
}) {
  const [name, setName] = useState(current?.name ?? "");
  const [kol, setKol] = useState(current?.category === "kol");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    work()
      .then(onDone)
      .catch((e: unknown) => setError(trackedError(e)))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="tw-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) run(() => saveTrackedWallet(wallet, name.trim(), kol));
      }}
    >
      <input
        aria-label="Label"
        placeholder="Name this wallet"
        value={name}
        maxLength={nameMax}
        autoFocus
        onChange={(e) => setName(e.target.value)}
      />
      <label className="check small">
        <input type="checkbox" checked={kol} onChange={(e) => setKol(e.target.checked)} />
        Show it with the KOLs
      </label>
      <div className="tw-actions">
        <button type="submit" className="small" disabled={busy || !name.trim()}>
          Save
        </button>
        {current && (
          <button
            type="button"
            className="ghost small danger"
            disabled={busy}
            onClick={() => run(() => removeTrackedWallet(wallet))}
          >
            Remove
          </button>
        )}
        <button type="button" className="ghost small" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

/** Past this many labels the list gets a filter box. */
const FILTER_FROM = 8;

/** One import's outcome, as the reader reads it. */
function importText(r: { added: number; updated: number; overCap: number; skipped: number }, cap: number) {
  const parts = [`${r.added} added`];
  if (r.updated) parts.push(`${r.updated} renamed`);
  if (r.overCap) parts.push(`${r.overCap} left out past your ${cap} limit`);
  if (r.skipped) parts.push(`${r.skipped} skipped with no valid address or name`);
  return `Imported: ${parts.join(", ")}.`;
}

/** Hands the browser the reader's labels as a JSON file. */
function saveExport(wallets: readonly TrackedWallet[]) {
  const url = URL.createObjectURL(new Blob([labelExport(wallets)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "trenchscanner-wallet-labels.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const kindText = (t: TrackedWallet) => (t.category === "kol" ? "KOL" : "User Tracked");

/**
 * The wallet view's own-label line (user ask 2026-10-18): the reader's label on this wallet and a
 * way to add, edit or remove it. Pro Mode only; nothing shows otherwise.
 */
export function TrackedWalletEditor({ wallet }: { wallet: string }) {
  const tracked = useTrackedWallets();
  const [editing, setEditing] = useState(false);
  if (!tracked?.pro) return null;
  const current = tracked.wallets.find((w) => w.wallet === wallet);
  const full = !current && tracked.wallets.length >= tracked.cap;
  if (editing)
    return (
      <div className="tw-editor">
        <LabelForm
          wallet={wallet}
          current={current}
          nameMax={tracked.nameMax}
          onDone={() => setEditing(false)}
        />
      </div>
    );
  return (
    <p className="tw-editor small">
      {current ? (
        <>
          <span className={`tm-tag ${current.category === "kol" ? "k-kol" : "k-tracked"}`}>
            {kindText(current)}: {current.name}
          </span>
          <span className="faint">Your label, only you see it</span>
          <button type="button" className="link" onClick={() => setEditing(true)}>
            Edit
          </button>
        </>
      ) : (
        <button
          type="button"
          className="link"
          disabled={full}
          title={
            full
              ? `You have labeled ${tracked.cap} wallets. Remove one in Utilities › Wallet labels to add another.`
              : undefined
          }
          onClick={() => setEditing(true)}
        >
          Label this wallet
        </button>
      )}
      <span className="faint num">
        {tracked.wallets.length}/{tracked.cap}
      </span>
    </p>
  );
}

/**
 * Settings › Wallet labels and Utilities › Wallet labels (user asks 2026-10-18): every wallet the
 * reader labeled, to edit or remove, and a box to label one by address. Shown to Pro Mode accounts,
 * and to any account that still holds labels from when it had Pro Mode (kept, but shown nowhere
 * until it has it again). With `upsell` (Utilities), an account without Pro Mode or labels gets a
 * short note on what the labels do and how to get Pro Mode instead of nothing. The list is the
 * reader's own (GET /wallets/tracked, per account): nothing here is shared with anyone else.
 */
export function TrackedWalletsPanel({ upsell = false }: { upsell?: boolean } = {}) {
  const tracked = useTrackedWallets();
  const [editing, setEditing] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!tracked) return null;
  if (!tracked.pro && tracked.wallets.length === 0)
    return upsell ? (
      <section className="panel tw-panel">
        <header className="section-head">
          <div>
            <span className="eyebrow">Pro Mode</span>
            <h2>Wallet labels</h2>
          </div>
        </header>
        <p className="muted small">
          With Pro Mode you can name up to {tracked.cap} wallets. Each shows like a KOL wallet, for you alone:
          its name in holder lists and on bubble maps, its probable side wallets tied to it, and its trades
          marked on charts.
        </p>
        <p className="small tw-upsell">
          To get Pro Mode, hold enough $ASDFASDFA to be one of the 250 largest wallets. We check every 5
          minutes, or press Check now on the Pro Mode card in Settings, and it switches on by itself.
        </p>
      </section>
    ) : null;
  const full = tracked.wallets.length >= tracked.cap;
  const typed = address.trim();
  const valid = ADDRESS_RE.test(typed);
  const q = filter.trim().toLowerCase();
  const shown = q
    ? tracked.wallets.filter((t) => t.name.toLowerCase().includes(q) || t.wallet.toLowerCase().includes(q))
    : tracked.wallets;
  const importFile = (file: File) => {
    setImporting(true);
    setError(null);
    setImported(null);
    (file.size > MAX_IMPORT_BYTES
      ? Promise.reject(new Error("That file is too large for a wallet label list (1 MB at most)."))
      : file.text()
    )
      .then(async (text) => {
        const parsed = parseLabelImport(text);
        if (parsed.entries.length === 0)
          throw new Error("No wallets with a valid address and a name in that file.");
        if (parsed.entries.length > tracked.cap)
          throw new Error(
            `That file lists ${parsed.entries.length} wallets; you can label up to ${tracked.cap}.`,
          );
        const r = await importTrackedWallets(parsed.entries);
        setImported(importText({ ...r, skipped: parsed.skipped + r.unnamed }, tracked.cap));
      })
      .catch((e: unknown) => setError(trackedError(e)))
      .finally(() => {
        setImporting(false);
        if (fileRef.current) fileRef.current.value = "";
      });
  };
  const remove = (wallet: string) => {
    setBusy(wallet);
    setError(null);
    removeTrackedWallet(wallet)
      .catch((e: unknown) => setError(trackedError(e)))
      .finally(() => setBusy(null));
  };
  return (
    <section className="panel tw-panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">Pro Mode</span>
          <h2>Wallet labels</h2>
        </div>
        <span className="muted small num">
          {tracked.wallets.length} of {tracked.cap}
        </span>
      </header>
      <p className="muted small">
        Name any wallet and it shows like a KOL wallet, for you alone: its name in holder lists and on bubble
        maps, the wallets it funded and its probable sides tied to it, and its trades marked on charts. Mark
        it KOL to show it with the KOLs; otherwise it is User Tracked. Probable sides are worked out hourly.
        Your labels are private to your account: no one else sees them, and they never change the models,
        filters, alerts or the Side Wallet Checker&apos;s export.
      </p>
      <div className="tw-io">
        {tracked.pro && (
          <>
            <button
              type="button"
              className="ghost small"
              disabled={importing}
              title={
                'A JSON list of wallets and names, such as [{"wallet": "…", "name": "…", "kol": false}] or {"<address>": "<name>"}'
              }
              onClick={() => fileRef.current?.click()}
            >
              {importing ? "Importing…" : "Import JSON"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importFile(file);
              }}
            />
          </>
        )}
        {tracked.wallets.length > 0 && (
          <button type="button" className="ghost small" onClick={() => saveExport(tracked.wallets)}>
            Export JSON
          </button>
        )}
        {tracked.wallets.length > FILTER_FROM && (
          <input
            className="tw-filter"
            aria-label="Filter labels"
            placeholder="Filter by name or address"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </div>
      {imported && <p className="small muted">{imported}</p>}
      {!tracked.pro && (
        <p className="warn small">
          Your labels are kept, but show only while you have Pro Mode. You can still remove them.
        </p>
      )}
      {q && shown.length === 0 && <p className="small muted">No label matches that.</p>}
      {shown.length > 0 && (
        <ul className="tw-list">
          {shown.map((t) =>
            editing === t.wallet ? (
              <li key={t.wallet} className="tw-row editing">
                <LabelForm
                  wallet={t.wallet}
                  current={t}
                  nameMax={tracked.nameMax}
                  onDone={() => setEditing(null)}
                />
              </li>
            ) : (
              <li key={t.wallet} className="tw-row">
                <span className={`tm-tag ${t.category === "kol" ? "k-kol" : "k-tracked"}`}>
                  {kindText(t)}
                </span>
                <strong className="tw-name">{t.name}</strong>
                <button
                  type="button"
                  className="link num"
                  title="Open this wallet"
                  onClick={() => openWallet(t.wallet)}
                >
                  {shortAddress(t.wallet)}
                </button>
                <span className="tw-actions">
                  {tracked.pro && (
                    <button type="button" className="ghost small" onClick={() => setEditing(t.wallet)}>
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost small danger"
                    disabled={busy === t.wallet}
                    onClick={() => remove(t.wallet)}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
      {tracked.pro &&
        (adding ? (
          <div className="tw-row editing">
            <span className="num small muted">{shortAddress(adding)}</span>
            <LabelForm
              wallet={adding}
              current={tracked.wallets.find((w) => w.wallet === adding)}
              nameMax={tracked.nameMax}
              onDone={() => {
                setAdding(null);
                setAddress("");
              }}
            />
          </div>
        ) : (
          <form
            className="tw-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) setAdding(typed);
            }}
          >
            <input
              aria-label="Wallet address"
              placeholder={full ? `All ${tracked.cap} labels used` : "Wallet address to label"}
              value={address}
              disabled={full}
              onChange={(e) => setAddress(e.target.value)}
            />
            <button type="submit" className="small" disabled={full || !valid}>
              Label
            </button>
          </form>
        ))}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
