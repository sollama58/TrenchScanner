/**
 * Wallet label import and export as JSON (user ask 2026-10-18). The import reads the shapes people
 * are likely to have on hand and turns each into { wallet, name, kol } for POST
 * /wallets/tracked/import, which cleans the names and holds the account to its cap:
 * - our own export: [{ "wallet": "...", "name": "...", "kol": true }]
 * - an address-to-name map: { "<address>": "<name>" }
 * - other trackers' lists: objects keyed address, walletAddress, trackedWalletAddress or wallet,
 *   named by name, label, alias, nickname or tag, and marked KOL by kol: true or category "kol";
 *   such a list may also sit under a "wallets", "labels" or "data" key.
 */

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADDRESS_KEYS = ["wallet", "address", "walletAddress", "trackedWalletAddress", "wallet_address"];
const NAME_KEYS = ["name", "label", "alias", "nickname", "tag"];
const LIST_KEYS = ["wallets", "labels", "data", "items"];

export interface ImportEntry {
  wallet: string;
  name: string;
  kol: boolean;
}

export interface ParsedImport {
  /** Unique by wallet, in the file's order; a wallet listed twice takes its last entry. */
  entries: ImportEntry[];
  /** Entries left out: no valid Solana address, or no name. */
  skipped: number;
}

/** The largest file read: a full 250-wallet list is well under 100 KB. */
export const MAX_IMPORT_BYTES = 1024 * 1024;
/**
 * A name's longest form as sent: the API keeps 32 characters once it has cleaned it, and this
 * keeps a full 250-entry request under its 64 KB body limit even with four-byte characters.
 */
const NAME_SEND_MAX = 40;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const nameOf = (v: unknown): string | null => {
  const s = str(v)?.replace(/\s+/g, " ");
  return s ? [...s].slice(0, NAME_SEND_MAX).join("") : null;
};

function fromObject(o: Record<string, unknown>): ImportEntry | null {
  const wallet = ADDRESS_KEYS.map((k) => str(o[k])).find((v) => v !== null) ?? null;
  const name = NAME_KEYS.map((k) => nameOf(o[k])).find((v) => v !== null) ?? null;
  if (!wallet || !name || !ADDRESS_RE.test(wallet)) return null;
  const kol = o.kol === true || (typeof o.category === "string" && o.category.toLowerCase() === "kol");
  return { wallet, name, kol };
}

/** A file's text as label entries; throws a reader-facing message when it isn't a list it can read. */
export function parseLabelImport(text: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    const nested = LIST_KEYS.map((k) => o[k]).find((v) => Array.isArray(v));
    if (nested) data = nested;
  }
  const out = new Map<string, ImportEntry>();
  let skipped = 0;
  const add = (e: ImportEntry | null) => {
    if (!e) {
      skipped += 1;
      return;
    }
    out.delete(e.wallet);
    out.set(e.wallet, e);
  };
  if (Array.isArray(data)) {
    for (const item of data)
      add(
        item && typeof item === "object" && !Array.isArray(item)
          ? fromObject(item as Record<string, unknown>)
          : null,
      );
  } else if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const name = nameOf(value);
      if (name && ADDRESS_RE.test(key)) add({ wallet: key, name, kol: false });
      else if (value && typeof value === "object" && !Array.isArray(value))
        add(fromObject({ wallet: key, ...(value as Record<string, unknown>) }));
      else add(null);
    }
  } else throw new Error("Expected a list of wallets and names.");
  return { entries: [...out.values()], skipped };
}

/** The reader's labels as our export shape, which parseLabelImport reads back. */
export function labelExport(
  wallets: readonly { wallet: string; name: string; category: "kol" | "tracked" }[],
): string {
  return `${JSON.stringify(
    wallets.map((w) => ({ wallet: w.wallet, name: w.name, kol: w.category === "kol" })),
    null,
    2,
  )}\n`;
}
