import { prisma, createLogger } from "@trenchscanner/core";

const logger = createLogger("ai-playbook");

/** The playbook the live reviewer runs with. */
export interface ActivePlaybook {
  id: string;
  version: number;
  text: string;
}

/** How long the live reviewer reuses the active playbook before re-reading it. */
const ACTIVE_CACHE_TTL_MS = 10 * 60_000;
let activeCache: { fetchedAt: number; playbook: ActivePlaybook } | null = null;

/** Test hook, and what a promotion calls so the new playbook takes over at once. */
export function resetActivePlaybookCache(): void {
  activeCache = null;
}

/**
 * The active playbook, creating version 1 (empty - the fixed instructions alone) the first time
 * it is asked for. Null only when the table can't be read; the reviewer then runs without one.
 */
export async function activePlaybook(): Promise<ActivePlaybook | null> {
  if (activeCache && Date.now() - activeCache.fetchedAt < ACTIVE_CACHE_TTL_MS) return activeCache.playbook;
  try {
    const playbook = await ensureActivePlaybook();
    activeCache = { fetchedAt: Date.now(), playbook };
    return playbook;
  } catch (err) {
    logger.warn("could not load the active playbook", { error: String(err) });
    return null;
  }
}

export async function ensureActivePlaybook(): Promise<ActivePlaybook> {
  const select = { id: true, version: true, text: true } as const;
  const active = await prisma.aiPlaybook.findFirst({
    where: { status: "active" },
    orderBy: { createdAt: "desc" },
    select,
  });
  if (active) return active;
  return prisma.aiPlaybook.create({ data: { version: 1, status: "active", text: "" }, select });
}
