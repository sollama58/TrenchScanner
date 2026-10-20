import { prisma, RISKY_WALLET_SCORE } from "@trenchscanner/core";
import { loadPossibleSides } from "./possibleSides.js";
import { loadWalletNames, type WalletName } from "./walletNames.js";

/**
 * What TrenchScanner knows of a coin's live traders, sent with its live trades (user asks
 * 2026-10-20): a trade arrives already known as a KOL's or one of its sides' (with the KOL's name
 * and picture), or a risky wallet's, a known dumper's or a winner's, so the chart marks it at once
 * instead of after the page asks POST /wallets/names (a queue shared with the paid identity reads,
 * under that route's rate limit). From TrenchScanner's own tables only: the KOL roster, the Side
 * Wallet Checker's labels and the wallet book (WalletRisk), never Helius. The reader's own labels
 * (trackedWallets.ts) still come with the chart's own read.
 */

export interface LiveTraderLabel {
  /** A roster KOL ("kol") or one of its Known Sides ("kol-side"), named as /wallets/names names it. */
  name?: { name: string; source: "kol" | "kol-side"; avatar?: string };
  /** A KOL's funded wallet or Probable Side: its strongest tie, funded ahead of probable. */
  side?: { kolWallet: string; kolName: string | null; funded?: true; avatar?: string };
  /** The wallet book's flags: a risk score of RISKY_WALLET_SCORE or more, a known dumper, a winner. */
  risky?: true;
  dumper?: true;
  winner?: true;
}

/** How long a wallet's answer (a tie, or none) is kept: a label changes once a day at most. */
const LABEL_TTL_MS = 10 * 60_000;
/** Wallets kept at most; past it the cache starts over. */
const MAX_KEPT = 50_000;

const kept = new Map<string, { label: LiveTraderLabel | null; at: number }>();

/** Exported for tests. Forgets every kept answer. */
export function resetLiveTraderLabels(): void {
  kept.clear();
}

/** Exported for tests. A wallet's label from its name, side ties and wallet book row; null for none. */
export function traderLabel(
  name: WalletName | undefined,
  sides: readonly { kolWallet: string; kolName: string | null; funded?: boolean; known?: boolean }[],
  kolNames: Readonly<Record<string, WalletName>>,
  risk?: { score: number; dumper: boolean; winner: boolean },
): LiveTraderLabel | null {
  const out: LiveTraderLabel = {};
  if (name && (name.source === "kol" || name.source === "kol-side"))
    out.name = { name: name.name, source: name.source, ...(name.avatar ? { avatar: name.avatar } : {}) };
  else {
    // A Known Side comes named as one above; a KOL is never someone else's side.
    const others = sides.filter((s) => !s.known);
    const s = others.find((x) => x.funded) ?? others[0];
    if (s) {
      const avatar = kolNames[s.kolWallet]?.avatar;
      out.side = {
        kolWallet: s.kolWallet,
        kolName: s.kolName,
        ...(s.funded ? { funded: true as const } : {}),
        ...(avatar ? { avatar } : {}),
      };
    }
  }
  if (risk && risk.score >= RISKY_WALLET_SCORE) out.risky = true;
  if (risk?.dumper) out.dumper = true;
  if (risk?.winner) out.winner = true;
  return Object.keys(out).length > 0 ? out : null;
}

/** The labels of the `wallets` that have one. Failures read as none, so the feed never waits on them. */
export async function liveTraderLabels(
  wallets: readonly string[],
  now = Date.now(),
): Promise<Record<string, LiveTraderLabel>> {
  const unique = [...new Set(wallets)];
  const due = unique.filter((w) => {
    const k = kept.get(w);
    return !k || now - k.at >= LABEL_TTL_MS;
  });
  if (due.length > 0) {
    try {
      // The database's names only (no identity reader): KOLs, Known Sides, exchanges.
      const [names, sides, risks] = await Promise.all([
        loadWalletNames(due, null).then((r) => r.names),
        loadPossibleSides(due),
        prisma.walletRisk.findMany({
          where: { wallet: { in: due } },
          select: { wallet: true, score: true, dumper: true, winner: true },
        }),
      ]);
      const risk = new Map(risks.map((r) => [r.wallet, r]));
      const kolWallets = [
        ...new Set(Object.values(sides).flatMap((list) => list.map((s) => s.kolWallet))),
      ].filter((w) => !names[w]);
      const kolNames = kolWallets.length
        ? { ...names, ...(await loadWalletNames(kolWallets, null)).names }
        : names;
      if (kept.size + due.length > MAX_KEPT) kept.clear();
      for (const w of due)
        kept.set(w, { label: traderLabel(names[w], sides[w] ?? [], kolNames, risk.get(w)), at: now });
    } catch {
      // Asked again with the next answer.
    }
  }
  const out: Record<string, LiveTraderLabel> = {};
  for (const w of unique) {
    const label = kept.get(w)?.label;
    if (label) out[w] = label;
  }
  return out;
}
