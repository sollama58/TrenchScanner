/**
 * KOL wallets named by hand, for wallets Solana Tracker's roster leaves out or names wrongly. The
 * worker writes these into KolWallet on boot and after every roster read (kolWalletsJob.ts), so
 * every place that shows a KOL name reads them like any roster KOL: holder lists, the wallet
 * modal, the Side Wallet Checker, possible-side labels, bubble maps and their share images. An
 * entry here wins over the roster's name and is never dropped as stale.
 */
export interface KolOverride {
  name: string;
  /** X handle without the "@", when known. */
  twitter?: string | null;
}

export const KOL_OVERRIDES: ReadonlyMap<string, KolOverride> = new Map([
  // User ask 2026-10-14: the roster's entry for this wallet showed broken.
  ["5hAgYC8TJCcEZV7LTXAzkTrm7YL29YXyQQJPCNrG84zM", { name: "Schoen" }],
  // User ask 2026-10-14: name these two wallets as these KOLs.
  ["7mHqL9GzGnbsYLoHLDzB7FiHAZbND2CZCJYFvU9PU1d3", { name: "Kimba" }],
  ["5sNnKuWKUtZkdC1eFNyqz3XHpNoCRQ1D1DfHcNHMV7gn", { name: "cryptovillian26" }],
  // User ask 2026-10-15: name this wallet as this KOL.
  ["2iPgNgss7ow3v5YFkTpzABStfjFSyG3BGvP5sZqADtFM", { name: "Jdn" }],
  // User ask 2026-10-16: name this wallet as this KOL.
  ["5YRgrP3mjGzrzirYYN5HAQH19cTYREYwGxW6XRJQUzij", { name: "Slingoor" }],
  // User ask 2026-10-16: name this wallet as this KOL.
  ["VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1", { name: "Beanzz" }],
  // User ask 2026-10-16: name this wallet as this KOL.
  ["bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa", { name: "bwam_dev" }],
  // User ask 2026-10-16: name these seven wallets as these KOLs.
  ["4S8YBCt6hhi7Nr1NnKF6jF856LLN8JJFzD1a8nF5UuHA", { name: "shaka" }],
  ["ALauG4FwEYDgSXd5Hen6kvuWSCdUi2fYNSNqM1Ci31wE", { name: "Thurston" }],
  ["722tXm5uB5uuG2tC43uKHXQ7Pbyz75pTokEAJv9x5VTx", { name: "caller100x" }],
  ["Hi5yNvPSfagdja5xjYMTYWnnjSE3ze5KsezTLfuD2mqd", { name: "gambles.sol" }],
  ["9tRff7L6Mx3ZDNBoGPffdjD3c9JNzLc3nxzadYH4TnAp", { name: "Woozy" }],
  ["AuPp4YTMTyqxYXQnHc5KUc6pUuCSsHQpBJhgnD45yqrf", { name: "Dani" }],
  ["DwCp9GZw3ueoXPykHSPUkRZEwcTVbJH2i9Sf1cXYicWf", { name: "wizard" }],
]);

/**
 * A KOL with more than one wallet on the roster, and which of them is the KOL's main wallet (user
 * ask 2026-10-14). Every other roster wallet whose name or X handle matches is a Known Side of it:
 * the worker writes the main wallet into KolWallet.mainWallet on those rows (applyKnownSides in
 * kolWalletsJob.ts), and the dashboard labels them "<KOL> Known Side" in place of a second KOL:
 * holder lists, the wallet modal, the Side Wallet Checker, bubble maps and their share images.
 * Add another KOL here to sort its duplicate entries the same way.
 */
export interface KolMain {
  /** The KOL's main wallet. */
  wallet: string;
  /** The name the main wallet's row gets when the roster doesn't list it. */
  name: string;
  /** Roster names that are this KOL, compared by normalizeKolName ("Cupsey 2" matches "cupsey"). */
  names: readonly string[];
  /** X handles (without the "@") that are this KOL, any case. */
  twitter: readonly string[];
  /** Wallets that are this KOL's sides whatever the roster names them. */
  sides?: readonly string[];
}

export const KOL_MAINS: readonly KolMain[] = [
  {
    // User ask 2026-10-14: cupseyy has several roster entries; this one is the main wallet.
    wallet: "2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f",
    name: "Cupsey",
    names: ["Cupsey", "Cupseyy"],
    twitter: ["Cupseyy", "Cupsey"],
  },
];

/** A roster name as matched against KOL_MAINS: lower case, letters and digits only, trailing digits dropped. */
export function normalizeKolName(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/[0-9]+$/, "");
}

/** The KOL main a roster row is a Known Side of, or null (the main wallet itself included). */
export function knownSideMain(
  row: { wallet: string; name: string | null; twitter: string | null },
  mains: readonly KolMain[] = KOL_MAINS,
): KolMain | null {
  const name = normalizeKolName(row.name);
  const handle = (row.twitter ?? "").replace(/^@+/, "").trim().toLowerCase();
  for (const m of mains) {
    if (row.wallet === m.wallet) return null;
    if (m.sides?.includes(row.wallet)) return m;
    if (name && m.names.some((n) => normalizeKolName(n) === name)) return m;
    if (handle && m.twitter.some((t) => t.toLowerCase() === handle)) return m;
  }
  return null;
}
