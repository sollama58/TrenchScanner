import {
  prisma,
  NARRATIVE_ROW_SELECT,
  narrativeReadFromRow,
  type Env,
  type NarrativeRead,
} from "@trenchscanner/core";
import { tokenSageEnabled } from "./prefetch.js";

/**
 * The stored TokenSage reads for the cycle's mints, as the models, filters and score consume
 * them. One query on the primary key; the raw analysis document stays out of it (it is the bulk
 * of the row, and nothing in the scan reads it). Empty while TokenSage is off, so switching it
 * off also stops every reader at once.
 */
export async function loadNarrativeReads(
  mintAddresses: string[],
  env: Env,
): Promise<Map<string, NarrativeRead>> {
  const out = new Map<string, NarrativeRead>();
  if (!tokenSageEnabled(env) || mintAddresses.length === 0) return out;
  const rows = await prisma.tokenNarrative.findMany({
    where: { mintAddress: { in: mintAddresses }, status: { in: ["complete", "partial"] } },
    select: NARRATIVE_ROW_SELECT,
  });
  for (const row of rows) {
    const read = narrativeReadFromRow(row);
    if (read) out.set(row.mintAddress, read);
  }
  return out;
}
