import { avatarHandle, prisma, withoutHandle } from "@trenchscanner/core";

/**
 * KOL roster rows (KolWallet) as the dashboard shows them. A Known Side (KolWallet.mainWallet set,
 * from core's KOL_MAINS) is another wallet of a KOL whose main wallet is listed: it reads
 * "<KOL> Known Side" everywhere, never as a second KOL.
 */
export interface KolRow {
  wallet: string;
  name: string | null;
  twitter: string | null;
  /** The KOL's main wallet and its name, on a Known Side. */
  main: { wallet: string; name: string | null } | null;
  /**
   * Its X picture's path on this API (GET /kol-avatars/:handle, kolAvatarRoutes.ts), when the
   * worker has one; a Known Side without a handle of its own shows its KOL's. Null: show a letter.
   */
  avatar: string | null;
}

/** The API path of each handle's stored picture, for the handles that have one. */
export async function readKolAvatars(twitters: readonly (string | null)[]): Promise<Map<string, string>> {
  const handles = [...new Set(twitters.flatMap((t) => avatarHandle(t) ?? []))];
  if (handles.length === 0) return new Map();
  // A picture is decoration: a failed read shows letters, never fails the names around it.
  const rows = await Promise.resolve()
    .then(() =>
      prisma.kolAvatar.findMany({
        where: { handle: { in: handles }, status: "ok" },
        select: { handle: true, hash: true },
      }),
    )
    .catch(() => []);
  return new Map(rows.map((r) => [r.handle, kolAvatarPath(r.handle, r.hash)]));
}

/** "/kol-avatars/cupseyy?v=<hash>": a new picture is a new URL, so browsers may cache one for good. */
export function kolAvatarPath(handle: string, hash: string | null): string {
  return `/kol-avatars/${encodeURIComponent(handle)}${hash ? `?v=${hash}` : ""}`;
}

const shortAddress = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** The roster rows of `wallets` that are on it, with each Known Side's main wallet named. */
export async function readKolRows(wallets: readonly string[]): Promise<Map<string, KolRow>> {
  const unique = [...new Set(wallets)];
  if (unique.length === 0) return new Map();
  const rows = await prisma.kolWallet.findMany({
    where: { wallet: { in: unique } },
    select: { wallet: true, name: true, twitter: true, mainWallet: true },
  });
  const mainWallets = [...new Set(rows.flatMap((r) => (r.mainWallet ? [r.mainWallet] : [])))];
  const mains = mainWallets.length
    ? await prisma.kolWallet.findMany({
        where: { wallet: { in: mainWallets } },
        select: { wallet: true, name: true, twitter: true },
      })
    : [];
  const mainName = new Map(mains.map((m) => [m.wallet, m.name?.trim() || null]));
  const mainTwitter = new Map(mains.map((m) => [m.wallet, m.twitter]));
  const handleOf = (r: (typeof rows)[number]) =>
    avatarHandle(r.twitter) ?? (r.mainWallet ? avatarHandle(mainTwitter.get(r.mainWallet)) : null);
  const avatars = await readKolAvatars(rows.map(handleOf));
  return new Map(
    rows.map((r) => [
      r.wallet,
      {
        wallet: r.wallet,
        name: r.name?.trim() || null,
        twitter: r.twitter?.trim() || null,
        main: r.mainWallet
          ? { wallet: r.mainWallet, name: mainName.get(r.mainWallet) ?? r.name?.trim() ?? null }
          : null,
        avatar: avatars.get(handleOf(r) ?? "") ?? null,
      },
    ]),
  );
}

/** "Cupsey Known Side": the name a Known Side goes by. */
export function knownSideName(main: { wallet: string; name: string | null }): string {
  return `${(main.name && withoutHandle(main.name)) || shortAddress(main.wallet)} Known Side`;
}
