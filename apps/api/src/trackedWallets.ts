import {
  isServiceWallet,
  KNOWN_EXCHANGE_WALLETS,
  MARKED_BOT_WALLETS,
  PLATFORM_WALLETS,
  Prisma,
  prisma,
  withoutHandle,
  type Env,
} from "@trenchscanner/core";
import { proStatus } from "./proMode.js";
import type { PossibleSide } from "./possibleSides.js";
import type { WalletName } from "./walletNames.js";
import { knownSideName } from "./kolRoster.js";

/**
 * User Tracked wallets (user ask 2026-10-18): a Pro Mode user labels any wallet, and from then on,
 * for that user alone, it reads like a KOL wallet: its name in every holder list and on the bubble
 * map, its funded wallets and Probable Sides tied to it on the map, its trades and theirs marked on
 * the chart. Marked "kol" it joins the KOLs; otherwise it is the "tracked" (User Tracked) kind.
 *
 * Private by construction: everything here is laid over a read after the shared part is built (or
 * read from a shared cache), keyed by the reader's own account. The models, the scan, the filters,
 * alerts, Telegram and every other user's views never read UserTrackedWallet or TrackedWalletSide.
 * Labels are kept while an account loses Pro Mode and show again once it has it back.
 */

/**
 * Labeled wallets per account at most (user ask 2026-10-18: 25, raised to 250 the same day with
 * JSON import). Labels cost no Helius calls; the hourly side run (trackedSidesJob.ts) batches them.
 */
export const TRACKED_WALLET_CAP = 250;
/** A label's longest name. */
export const TRACKED_NAME_MAX = 32;

export type TrackedCategory = "kol" | "tracked";

export interface TrackedWallet {
  wallet: string;
  name: string;
  category: TrackedCategory;
}

/** A label as Settings lists it. */
export interface TrackedWalletRow extends TrackedWallet {
  createdAt: string;
  updatedAt: string;
}

/**
 * A typed name as a label keeps it: control and zero-width characters out, runs of spaces as one,
 * trimmed, at most TRACKED_NAME_MAX characters. Null when nothing is left.
 */
export function cleanTrackedName(raw: string): string | null {
  const s = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s ? [...s].slice(0, TRACKED_NAME_MAX).join("").trim() : null;
}

const categoryOf = (c: string): TrackedCategory => (c === "kol" ? "kol" : "tracked");

/** Every label the account holds, newest first, Pro Mode or not. */
export async function listTracked(userId: string): Promise<TrackedWalletRow[]> {
  const rows = await prisma.userTrackedWallet.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: TRACKED_WALLET_CAP * 2,
  });
  return rows.map((r) => ({
    wallet: r.wallet,
    name: r.name,
    category: categoryOf(r.category),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export type SaveResult = { ok: true; row: TrackedWalletRow } | { ok: false; error: "cap" };

/**
 * Adds or renames a label. A new one past TRACKED_WALLET_CAP is refused; the count and the insert
 * run under a per-account lock, so two saves at once can't both take the last place.
 */
export async function saveTracked(
  userId: string,
  wallet: string,
  name: string,
  category: TrackedCategory,
): Promise<SaveResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tracked-wallets:${userId}`}))`;
    const existing = await tx.userTrackedWallet.findUnique({ where: { userId_wallet: { userId, wallet } } });
    if (!existing && (await tx.userTrackedWallet.count({ where: { userId } })) >= TRACKED_WALLET_CAP)
      return null;
    return tx.userTrackedWallet.upsert({
      where: { userId_wallet: { userId, wallet } },
      create: { userId, wallet, name, category },
      update: { name, category },
    });
  });
  forgetTracked(userId);
  if (!result) return { ok: false, error: "cap" };
  return {
    ok: true,
    row: {
      wallet: result.wallet,
      name: result.name,
      category: categoryOf(result.category),
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    },
  };
}

export interface ImportEntry {
  wallet: string;
  name: string;
  category: TrackedCategory;
}

export interface ImportResult {
  /** New labels added. */
  added: number;
  /** Labels already held, renamed or re-kinded to the file's. */
  updated: number;
  /** New wallets left out because the account reached TRACKED_WALLET_CAP. */
  overCap: number;
}

/**
 * Adds or renames many labels at once (a JSON list import): one transaction under the same
 * per-account lock as saveTracked. Labels already held take the file's name and kind; new ones are
 * added in the file's order until the account holds TRACKED_WALLET_CAP, and the rest are counted.
 * `entries` are already cleaned and unique by wallet.
 */
export async function importTracked(userId: string, entries: readonly ImportEntry[]): Promise<ImportResult> {
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tracked-wallets:${userId}`}))`;
      const held = new Set(
        (
          await tx.userTrackedWallet.findMany({
            where: { userId, wallet: { in: entries.map((e) => e.wallet) } },
            select: { wallet: true },
          })
        ).map((r) => r.wallet),
      );
      let room = TRACKED_WALLET_CAP - (await tx.userTrackedWallet.count({ where: { userId } }));
      const fresh: ImportEntry[] = [];
      let overCap = 0;
      for (const e of entries) {
        if (held.has(e.wallet)) continue;
        if (room > 0) {
          fresh.push(e);
          room -= 1;
        } else overCap += 1;
      }
      const updates = entries.filter((e) => held.has(e.wallet));
      for (const e of updates)
        await tx.userTrackedWallet.update({
          where: { userId_wallet: { userId, wallet: e.wallet } },
          data: { name: e.name, category: e.category },
        });
      if (fresh.length)
        await tx.userTrackedWallet.createMany({
          data: fresh.map((e) => ({ userId, wallet: e.wallet, name: e.name, category: e.category })),
          skipDuplicates: true,
        });
      return { added: fresh.length, updated: updates.length, overCap };
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
  forgetTracked(userId);
  return result;
}

/**
 * Why an imported entry was left out: TrenchScanner already labels that wallet for everyone. "kol"
 * a named KOL on the roster, "kol-side" a KOL's Known Side, "exchange" an exchange hot wallet,
 * "launchpad" a launchpad's own wallet (core's PLATFORM_WALLETS), "bot" a wallet marked as a bot.
 */
export type PlatformLabelKind = "kol" | "kol-side" | "exchange" | "launchpad" | "bot";

export interface PlatformLabel {
  wallet: string;
  /** The name TrenchScanner shows it by; null for a marked bot, which has none. */
  label: string | null;
  kind: PlatformLabelKind;
}

/**
 * Which of `wallets` TrenchScanner already labels for every reader (user ask 2026-10-19): a label
 * by hand is refused on these and a JSON import leaves them out, so a file can't rename a KOL, a Known Side, an exchange, a launchpad
 * wallet or a marked bot. Read from the roster and core's lists only: no Helius calls. Helius
 * identity names and Probable Sides aren't labels of ours, so those wallets can still be imported.
 */
export async function platformLabels(wallets: readonly string[]): Promise<Map<string, PlatformLabel>> {
  const unique = [...new Set(wallets)];
  const out = new Map<string, PlatformLabel>();
  if (unique.length === 0) return out;
  const rows = await prisma.kolWallet.findMany({
    where: { wallet: { in: unique } },
    select: { wallet: true, name: true, mainWallet: true },
  });
  const mainWallets = [...new Set(rows.flatMap((r) => (r.mainWallet ? [r.mainWallet] : [])))];
  const mains = new Map(
    mainWallets.length
      ? (
          await prisma.kolWallet.findMany({
            where: { wallet: { in: mainWallets } },
            select: { wallet: true, name: true },
          })
        ).map((m) => [m.wallet, m.name?.trim() || null])
      : [],
  );
  const kols = new Map(rows.map((r) => [r.wallet, r]));
  for (const w of unique) {
    // In the order walletNames.ts picks a name, so the reason given is the name shown.
    const platform = PLATFORM_WALLETS.get(w);
    const kol = kols.get(w);
    const kolName = kol?.name && withoutHandle(kol.name.trim());
    const exchange = KNOWN_EXCHANGE_WALLETS.get(w);
    if (platform) out.set(w, { wallet: w, label: platform, kind: "launchpad" });
    else if (kol?.mainWallet)
      out.set(w, {
        wallet: w,
        label: knownSideName({
          wallet: kol.mainWallet,
          name: mains.get(kol.mainWallet) ?? kol.name?.trim() ?? null,
        }),
        kind: "kol-side",
      });
    else if (kolName) out.set(w, { wallet: w, label: kolName, kind: "kol" });
    else if (exchange) out.set(w, { wallet: w, label: withoutHandle(exchange), kind: "exchange" });
    else if (MARKED_BOT_WALLETS.has(w)) out.set(w, { wallet: w, label: null, kind: "bot" });
  }
  return out;
}

/** Removes a label; whether there was one. */
export async function removeTracked(userId: string, wallet: string): Promise<boolean> {
  const { count } = await prisma.userTrackedWallet.deleteMany({ where: { userId, wallet } });
  forgetTracked(userId);
  return count > 0;
}

/** The labels a read lays over, per account, for this long: Pro Mode and the rows both. */
const ACTIVE_TTL_MS = 60_000;
const ACTIVE_MAX = 5_000;
const active = new Map<string, { at: number; value: Promise<TrackedWallet[]> }>();

/** Drops an account's cached labels (a save or a removal), so its next read has them. */
export function forgetTracked(userId: string): void {
  active.delete(userId);
}

/** For tests. */
export function resetTrackedCache(): void {
  active.clear();
}

/**
 * The labels that apply to this reader now: theirs while they have Pro Mode, none otherwise (and
 * none without a signed-in reader). Cached a minute per account; any failure reads as none, so a
 * label can never break the read it is laid over, and isn't kept: the next read asks again rather
 * than showing no labels for the rest of the minute.
 */
export async function activeTracked(
  env: Env | undefined,
  user: { userId: string; walletAddress: string } | undefined,
  now = Date.now(),
): Promise<TrackedWallet[]> {
  if (!env || !user || !env.PRO_TRADING_ENABLED) return [];
  const hit = active.get(user.userId);
  if (hit && now - hit.at < ACTIVE_TTL_MS) return hit.value;
  const value = (async () => {
    const rows = await prisma.userTrackedWallet.findMany({
      where: { userId: user.userId },
      select: { wallet: true, name: true, category: true },
      take: TRACKED_WALLET_CAP,
      orderBy: { createdAt: "asc" },
    });
    if (rows.length === 0) return [];
    if (!(await proStatus(env, user.walletAddress)).pro) return [];
    return rows.map((r) => ({ wallet: r.wallet, name: r.name, category: categoryOf(r.category) }));
  })().catch(() => {
    if (active.get(user.userId)?.value === value) active.delete(user.userId);
    return [] as TrackedWallet[];
  });
  if (active.size >= ACTIVE_MAX) active.clear();
  active.set(user.userId, { at: now, value });
  return value;
}

/** A label as a wallet name: with the KOLs or the User Tracked kind, and marked as the reader's own. */
export function trackedName(t: TrackedWallet): WalletName {
  return { name: t.name, source: t.category === "kol" ? "kol" : "tracked", mine: true };
}

/** `names` with the reader's labels over the wallets in `wallets` they labeled: their own name wins. */
export function withTrackedNames(
  names: Record<string, WalletName>,
  tracked: readonly TrackedWallet[],
  wallets: readonly string[],
): Record<string, WalletName> {
  if (tracked.length === 0) return names;
  const asked = new Set(wallets);
  const out = { ...names };
  for (const t of tracked) {
    if (!asked.has(t.wallet)) continue;
    const before = names[t.wallet];
    const own = trackedName(t);
    // A wallet they labeled KOL keeps the roster's X picture, if it has one; a label alone never fetches one.
    const avatar = own.source === "kol" ? before?.avatar : undefined;
    out[t.wallet] = {
      ...own,
      ...(before?.service ? { service: true as const } : {}),
      ...(avatar ? { avatar } : {}),
    };
  }
  return out;
}

/**
 * The side ties of `wallets` to the reader's labeled wallets: a wallet a labeled wallet funded
 * (paid for its first SOL, read from WalletFunder at once) and the hourly Probable Sides
 * (TrackedWalletSide). Shaped like the KOLs' (PossibleSide), with `tracked` naming the label's kind.
 * Bots and service wallets are no one's side; a labeled wallet is no side of its own.
 */
export async function loadTrackedSides(
  tracked: readonly TrackedWallet[],
  wallets: readonly string[],
): Promise<Record<string, PossibleSide[]>> {
  if (tracked.length === 0) return {};
  const byWallet = new Map(tracked.map((t) => [t.wallet, t]));
  const unique = [...new Set(wallets)].filter(
    (w) => !MARKED_BOT_WALLETS.has(w) && !isServiceWallet(w) && !byWallet.has(w),
  );
  if (unique.length === 0) return {};
  const labeled = [...byWallet.keys()];
  const [funded, probable] = await Promise.all([
    prisma.walletFunder.findMany({
      where: { wallet: { in: unique }, funder: { in: labeled } },
      select: { wallet: true, funder: true, fundedAt: true, amountSol: true },
    }),
    prisma.trackedWalletSide.findMany({
      where: { wallet: { in: unique }, trackedWallet: { in: labeled } },
      orderBy: [{ pct: "desc" }, { shared: "desc" }],
    }),
  ]);
  const out: Record<string, PossibleSide[]> = {};
  const has = (wallet: string, kolWallet: string) => out[wallet]?.some((s) => s.kolWallet === kolWallet);
  for (const f of funded) {
    const t = f.funder ? byWallet.get(f.funder) : undefined;
    if (!t) continue;
    const match = probable.find((p) => p.wallet === f.wallet && p.trackedWallet === t.wallet);
    (out[f.wallet] ??= []).push({
      kolWallet: t.wallet,
      kolName: t.name,
      pct: match?.pct ?? 0,
      shared: match?.shared ?? 0,
      kolCoins: match?.kolCoins ?? 0,
      hours: match?.hours ?? 0,
      ...(match?.transfers ? { transfers: match.transfers } : {}),
      funded: true,
      fundedAt: f.fundedAt,
      fundedSol: f.amountSol,
      tracked: t.category,
    });
  }
  for (const p of probable) {
    const t = byWallet.get(p.trackedWallet);
    if (!t || has(p.wallet, t.wallet)) continue;
    (out[p.wallet] ??= []).push({
      kolWallet: t.wallet,
      kolName: t.name,
      pct: p.pct,
      shared: p.shared,
      kolCoins: p.kolCoins,
      hours: p.hours,
      ...(p.transfers > 0 ? { transfers: p.transfers } : {}),
      tracked: t.category,
    });
  }
  return out;
}

/**
 * The shared side ties with the reader's own laid after them: a roster KOL's tie stays first, and
 * a labeled wallet that is itself on the roster keeps the roster's entry, renamed to the label.
 */
export function mergeSides(
  base: Record<string, PossibleSide[]>,
  extra: Record<string, PossibleSide[]>,
  tracked: readonly TrackedWallet[] = [],
): Record<string, PossibleSide[]> {
  const label = new Map(tracked.map((t) => [t.wallet, t]));
  const out: Record<string, PossibleSide[]> = {};
  for (const [w, list] of Object.entries(base))
    out[w] = list.map((s) => {
      const t = label.get(s.kolWallet);
      return t ? { ...s, kolName: t.name, tracked: t.category } : s;
    });
  for (const [w, list] of Object.entries(extra)) {
    const have = (out[w] ??= []);
    for (const s of list) if (!have.some((h) => h.kolWallet === s.kolWallet)) have.push(s);
  }
  return out;
}

/** The trade-tape rows of one coin the reader's labels touch: the labeled wallets and their sides. */
export interface TrackedActivityRow {
  wallet: string;
  isCreator: boolean;
  solIn: number;
  solOut: number;
  heldPctAtAnchor: number | null;
  firstBuyAt: Date | null;
  firstSellAt: Date | null;
  trades: unknown;
}

/**
 * One coin's trade-tape rows of the labeled wallets, their funded wallets and their Probable Sides.
 * One indexed read on the coin's rows; the side checks are primary-key lookups.
 */
export async function trackedActivity(
  tokenId: string,
  tracked: readonly TrackedWallet[],
): Promise<TrackedActivityRow[]> {
  if (tracked.length === 0) return [];
  const labeled = tracked.map((t) => t.wallet);
  return prisma.$queryRaw<TrackedActivityRow[]>(Prisma.sql`
    SELECT a."wallet", a."isCreator", a."solIn", a."solOut", a."heldPctAtAnchor",
           a."firstBuyAt", a."firstSellAt", a."trades"
    FROM "TokenWalletActivity" a
    WHERE a."tokenId" = ${tokenId}
      AND (a."wallet" = ANY(${labeled})
        OR EXISTS (SELECT 1 FROM "WalletFunder" f WHERE f."wallet" = a."wallet" AND f."funder" = ANY(${labeled}))
        OR EXISTS (SELECT 1 FROM "TrackedWalletSide" s
                   WHERE s."wallet" = a."wallet" AND s."trackedWallet" = ANY(${labeled})))
    LIMIT 500`);
}
