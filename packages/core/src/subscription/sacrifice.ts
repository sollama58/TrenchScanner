import { Prisma, prisma } from "../db.js";
import { creditPots, creditWalletLockKey, rawPerCredit } from "./credits.js";
import { asdfRawPerSol } from "./asdfPrice.js";
import { PRO_HOLDER_COUNT } from "./proHolders.js";

/**
 * The Sacrifice (ASDF fee plan, owner decisions 2026-10-18): a 0.2% fee on Pro trades, buys and
 * sells, by wallets below the free cut-off, paid from the wallet's burned credits (held in ASDF,
 * credits.ts) at the smoothed ASDF price (asdfPrice.ts). The swap itself is unchanged.
 *
 * Free: admins, Pro Mode grants and the ASDF access buy; and a holder ranked at or above
 * `freeRank` in the newest scan (kept down to `freeRank` + 10, capped at 250, once it has reached
 * it) that still holds at least what the cut-off wallet held in that scan. Everyone else pays.
 *
 * `mode` switches the whole thing: "off" works nothing out, "shadow" works it out and records it
 * but never takes it, "on" takes it. Both are admin settings (SacrificeSettings), read through a
 * 30 second cache, so they change without a deploy.
 */

export type SacrificeMode = "off" | "shadow" | "on";

export interface SacrificeSettingsValue {
  mode: SacrificeMode;
  /** Holders at or above this rank trade free (1 to 250). */
  freeRank: number;
}

/**
 * Off, and free for every Pro holder (all 250, PRO_HOLDER_COUNT), until an admin saves (owner
 * decision 2026-10-18). A literal: proHolders.ts imports this module, so its constants are read
 * here only inside functions.
 */
export const DEFAULT_SACRIFICE_SETTINGS: SacrificeSettingsValue = { mode: "off", freeRank: 250 };
/** The Sacrifice in basis points of the trade's SOL value: 0.2%. */
export const SACRIFICE_BPS = 20n;
/** Ranks below the cut-off a free wallet keeps its tier through. */
export const SACRIFICE_BUFFER_RANKS = 10;

const SETTINGS_ID = "sacrifice";
const SETTINGS_TTL_MS = 30_000;
let settingsCache: { at: number; value: SacrificeSettingsValue } | null = null;

const isMode = (v: string): v is SacrificeMode => v === "off" || v === "shadow" || v === "on";

/** The current settings: the admin's saved row, else the defaults. Cached SETTINGS_TTL_MS. */
export async function sacrificeSettings(): Promise<SacrificeSettingsValue> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const row = await prisma.sacrificeSettings.findUnique({ where: { id: SETTINGS_ID } });
  const value: SacrificeSettingsValue = row
    ? {
        mode: isMode(row.mode) ? row.mode : "off",
        freeRank: Math.min(Math.max(row.freeRank, 1), PRO_HOLDER_COUNT),
      }
    : DEFAULT_SACRIFICE_SETTINGS;
  settingsCache = { at: Date.now(), value };
  return value;
}

/** Saves new settings (Admin > Pro Mode). This process sees them at once, others within 30 s. */
export async function saveSacrificeSettings(
  value: SacrificeSettingsValue,
  admin: string,
): Promise<SacrificeSettingsValue> {
  const data = { mode: value.mode, freeRank: value.freeRank, updatedBy: admin };
  await prisma.sacrificeSettings.upsert({
    where: { id: SETTINGS_ID },
    update: data,
    create: { id: SETTINGS_ID, ...data },
  });
  settingsCache = { at: Date.now(), value };
  return value;
}

/** Tests: forget the cached settings. */
export function resetSacrificeSettingsCacheForTests(): void {
  settingsCache = null;
}

/** The lowest rank a wallet that has reached the free tier keeps it at. */
export function freeBufferRank(freeRank: number): number {
  return Math.min(freeRank + SACRIFICE_BUFFER_RANKS, PRO_HOLDER_COUNT);
}

/**
 * The scan's half of the tier (refreshProHolders calls it after writing the scan at `scanAt`):
 * starts the free tier of each wallet in it at or above the cut-off, keeps it for those within the
 * buffer that had it, and ends it for everyone else, including every wallet not in the scan.
 */
export async function updateFreeTiers(
  scanAt: Date,
  db: Pick<typeof prisma, "$executeRaw"> = prisma,
): Promise<void> {
  const { freeRank } = await sacrificeSettings();
  const buffer = freeBufferRank(freeRank);
  await db.$executeRaw`
    UPDATE "ProHolder" SET "freeTierSince" = CASE
      WHEN "lastInTopAt" = ${scanAt} AND "rank" <= ${freeRank} THEN COALESCE("freeTierSince", ${scanAt})
      WHEN "lastInTopAt" = ${scanAt} AND "rank" <= ${buffer} THEN "freeTierSince"
      ELSE NULL END
    WHERE "freeTierSince" IS NOT NULL OR ("lastInTopAt" = ${scanAt} AND "rank" <= ${freeRank})`;
}

export type SacrificeTier =
  | { pays: false; reason: "admin" | "grant" | "access" | "holder"; rank?: number }
  /**
   * below_cutoff: under the cut-off (or out of the scan, or in its grace); moved_bag: free by the
   * scan, but holds less than the cut-off wallet now.
   */
  | { pays: true; reason: "below_cutoff" | "moved_bag"; rank?: number };

/**
 * The wallet's tier for a trade now. `source` is its Pro Mode source (apps/api proMode.ts);
 * `access` an ASDF access buy by a wallet without Pro Mode; `liveBalance` reads the wallet's ASDF
 * now (null when the read fails: the scan's tier stands, rather than charging on a failed read).
 */
export async function sacrificeTier(input: {
  wallet: string;
  source: "admin" | "grant" | "holder" | "grace" | null;
  access?: boolean;
  liveBalance: () => Promise<bigint | null>;
}): Promise<SacrificeTier> {
  if (input.source === "admin" || input.source === "grant") return { pays: false, reason: input.source };
  if (input.access) return { pays: false, reason: "access" };
  const row = await prisma.proHolder.findUnique({
    where: { walletAddress: input.wallet },
    select: { rank: true, lastInTopAt: true, freeTierSince: true },
  });
  if (!row?.freeTierSince) return { pays: true, reason: "below_cutoff", rank: row?.rank };
  const { freeRank } = await sacrificeSettings();
  // The cut-off may have been lowered since the scan that set the tier.
  const cutoffRank = row.rank <= freeRank ? freeRank : freeBufferRank(freeRank);
  if (row.rank > cutoffRank) return { pays: true, reason: "below_cutoff", rank: row.rank };
  // The cut-off wallet in the same scan: the one at that rank, or the last if the scan was shorter.
  const cutoff = await prisma.proHolder.findFirst({
    where: { lastInTopAt: row.lastInTopAt, rank: { lte: cutoffRank } },
    orderBy: { rank: "desc" },
    select: { heldRaw: true },
  });
  // heldRaw is floored to a millionth of supply (proHolders.ts heldOf), so the cut-off wallet's own
  // live balance is never under it; a scan that kept no amounts can't be checked.
  if (cutoff?.heldRaw && /^\d+$/.test(cutoff.heldRaw)) {
    const live = await input.liveBalance();
    if (live !== null && live < BigInt(cutoff.heldRaw))
      return { pays: true, reason: "moved_bag", rank: row.rank };
  }
  return { pays: false, reason: "holder", rank: row.rank };
}

export interface SacrificeAmount {
  /** ASDF base units taken from the burned pot. */
  asdfRaw: bigint;
  /** The same as credits at the current price, rounded up to hundredths: what the trader is shown. */
  credits: number;
  /** Its SOL value, lamports (0.2% of the trade, rounded up). */
  lamports: bigint;
  /** The ASDF base units per SOL it was worked out at. */
  asdfRawPerSol: bigint;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * The Sacrifice on a trade worth `lamports` (a buy's spend, a sale's quoted SOL out): 0.2% of it
 * in ASDF base units at `asdfPerSol` whole ASDF per SOL, rounded up. BigInt maths only.
 */
export function sacrificeFor(lamports: bigint, asdfPerSol: number, tokensPerCredit: number): SacrificeAmount {
  const perSol = asdfRawPerSol(asdfPerSol);
  const value = lamports < 0n ? 0n : lamports;
  const asdfRaw = ceilDiv(value * SACRIFICE_BPS * perSol, BPS * LAMPORTS_PER_SOL);
  const credits =
    tokensPerCredit > 0 ? Number(ceilDiv(asdfRaw * 100n, rawPerCredit(tokensPerCredit))) / 100 : 0;
  return { asdfRaw, credits, lamports: ceilDiv(value * SACRIFICE_BPS, BPS), asdfRawPerSol: perSol };
}

/** Credits needed for `asdfRaw` beyond a burned pot of `burnedRaw`, whole credits, rounded up. */
export function creditsShort(asdfRaw: bigint, burnedRaw: bigint, tokensPerCredit: number): number {
  if (asdfRaw <= burnedRaw || tokensPerCredit <= 0) return 0;
  return Number(ceilDiv(asdfRaw - burnedRaw, rawPerCredit(tokensPerCredit)));
}

/** What the send records for one Pro trade, and the Sacrifice it takes. */
export interface PlatformTradeRecord {
  signature: string;
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  lamports: bigint;
  networkFeeLamports: bigint;
  sacrifice: {
    mode: SacrificeMode;
    /** The tier's reason, null in "off" mode. */
    tier: SacrificeTier["reason"] | null;
    pays: boolean;
    /** ASDF base units; null when nothing was priced (off, free, or a price refusal in shadow). */
    asdfRaw: bigint | null;
    lamports: bigint | null;
    asdfPerSol: number | null;
  };
}

export type RecordTradeOutcome =
  | { status: "recorded"; taken: bigint }
  /** "on", a fee payer, and the burned pot no longer covers it: nothing was written. */
  | { status: "short"; burnedRaw: bigint; asdfRaw: bigint };

/**
 * The send's one database transaction (Build guide step 5), before the trade goes to Sender:
 * under the wallet's credit lock, re-checks the burned pot, writes the "sacrifice" row (burned
 * source, the trade's signature) and the PlatformTrade row with the Sacrifice. Two sends at once
 * can't spend the same credits, and a charge is never unrecorded. "shadow" records the Sacrifice on
 * the trade but takes nothing; "off" records the trade alone.
 */
export async function recordPlatformTrade(r: PlatformTradeRecord): Promise<RecordTradeOutcome> {
  const s = r.sacrifice;
  const take = s.mode === "on" && s.pays && s.asdfRaw !== null && s.asdfRaw > 0n ? s.asdfRaw : 0n;
  return prisma.$transaction(async (tx) => {
    if (take > 0n) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${creditWalletLockKey(r.wallet)}))`;
      const pots = await creditPots(r.wallet, tx);
      if (pots.burnedRaw < take)
        return { status: "short" as const, burnedRaw: pots.burnedRaw, asdfRaw: take };
      await tx.burnCreditEntry.create({
        data: {
          wallet: r.wallet,
          delta: 0,
          kind: "sacrifice",
          source: "burned",
          asdfRaw: -take,
          tradeSignature: r.signature,
          subject: r.mint,
          note: r.side,
        },
      });
    }
    await tx.platformTrade.create({
      data: {
        signature: r.signature,
        wallet: r.wallet,
        mint: r.mint,
        side: r.side,
        lamports: r.lamports,
        networkFeeLamports: r.networkFeeLamports,
        platformFeeLamports: take > 0n ? (s.lamports ?? 0n) : 0n,
        sacrificeAsdfRaw: s.pays && s.mode !== "off" ? (s.asdfRaw ?? 0n) : 0n,
        asdfPerSol: s.asdfPerSol !== null ? String(s.asdfPerSol) : null,
        feeTier: s.tier,
        sacrificeMode: s.mode === "off" ? null : s.mode,
      },
    });
    return { status: "recorded" as const, taken: take };
  });
}

/**
 * Puts a trade's Sacrifice back (it failed, expired, or never went out): one "sacrifice-refund"
 * row for what its "sacrifice" row took. The unique (kind, tradeSignature) makes a second attempt
 * a no-op, so the settlement job and the panel can race. Returns the ASDF base units refunded.
 */
export async function refundSacrifice(signature: string): Promise<bigint> {
  const spent = await prisma.burnCreditEntry.findUnique({
    where: { kind_tradeSignature: { kind: "sacrifice", tradeSignature: signature } },
    select: { wallet: true, asdfRaw: true, subject: true, note: true },
  });
  if (!spent?.asdfRaw || spent.asdfRaw >= 0n) return 0n;
  try {
    await prisma.burnCreditEntry.create({
      data: {
        wallet: spent.wallet,
        delta: 0,
        kind: "sacrifice-refund",
        source: "burned",
        asdfRaw: -spent.asdfRaw,
        tradeSignature: signature,
        subject: spent.subject,
        note: spent.note,
      },
    });
    return -spent.asdfRaw;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return 0n;
    throw err;
  }
}
