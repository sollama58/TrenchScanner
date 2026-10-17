import { adminWalletSet, prisma, type Env } from "@trenchscanner/core";

/**
 * Pro Mode (user decision 2026-10-17): who sees the token modal's Trade panel. Admin wallets
 * always; anyone else only with a ProModeGrant row, added in Admin > Access. Off for everyone
 * while PRO_TRADING_ENABLED is "false".
 */
export async function isProWallet(env: Env, walletAddress: string): Promise<boolean> {
  if (!env.PRO_TRADING_ENABLED) return false;
  if (adminWalletSet(env).has(walletAddress)) return true;
  const grant = await prisma.proModeGrant.findUnique({
    where: { walletAddress },
    select: { walletAddress: true },
  });
  return grant !== null;
}
