import type { ParsedFeeRecipient } from "./feeRecipients.js";

/**
 * Charity names from donate.gg (user ask 2026-10-23). A Pump.fun charity coin pays its fee to a
 * DonationFeePda, and TokenSage reads that PDA's donate.gg config id onto the recipient
 * (`charity_config_id`). donate.gg's public `GET /api/v1/configs/{configId}` names each charity
 * on that config and its weight, with no API key. Pump.fun's own coin endpoint was the only
 * name source before, and it refuses this server (403 since 2026-10-22), so the cards showed
 * the donation PDA's address. Configs are permanent, so a loaded config is kept for a day.
 */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEFAULT_BASE = "https://www.donate.gg/api/v1";
const MAX_NAME_CHARS = 80;
/** A config does not change once created. */
const CONFIG_OK_MS = 24 * 60 * 60_000;
/** A config that answered with no charity, or a 404, is asked again after this. */
const CONFIG_MISS_MS = 10 * 60_000;
const MAX_CACHED = 2_000;

/** One charity on a donate.gg config: its name and its share of the config, in basis points. */
export interface DonateCharity {
  name: string;
  /** Share of the config's donation in basis points. The shares on a config sum to 10000. */
  bps: number;
}

const cache = new Map<string, { charities: DonateCharity[]; until: number }>();

function charityName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || !/\p{L}/u.test(text) || BASE58.test(text)) return null;
  return text.length > MAX_NAME_CHARS ? text.slice(0, MAX_NAME_CHARS).trimEnd() : text;
}

function weight(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The charities on a donate.gg config response, each with its share. Disabled charities and
 * rows with no usable name are left out. A config with no weights splits evenly. Empty when
 * the body is not a config.
 */
export function charitiesFromDonateConfig(body: unknown): DonateCharity[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const list = (body as { charities?: unknown }).charities;
  if (!Array.isArray(list)) return [];
  const rows: { name: string; weight: number | null }[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as { name?: unknown; weight?: unknown; isEnabled?: unknown };
    if (row.isEnabled === false) continue;
    const name = charityName(row.name);
    if (!name) continue;
    rows.push({ name, weight: weight(row.weight) });
    if (rows.length >= 10) break;
  }
  if (rows.length === 0) return [];
  const total = rows.reduce((sum, row) => sum + (row.weight ?? 0), 0);
  if (!(total > 0)) {
    return rows.map((row) => ({ name: row.name, bps: Math.round(10_000 / rows.length) }));
  }
  return rows.map((row) => ({ name: row.name, bps: Math.round(((row.weight ?? 0) / total) * 10_000) }));
}

/**
 * The charities on each of these donate.gg configs, remembered so a feed poll does not ask
 * again. A transport failure is not remembered: the next read can try. Never throws.
 */
export async function donateConfigCharities(
  configIds: readonly string[],
  timeoutMs = 2_500,
): Promise<Map<string, DonateCharity[]>> {
  const now = Date.now();
  const out = new Map<string, DonateCharity[]>();
  const todo: string[] = [];
  for (const id of new Set(configIds)) {
    if (!BASE58.test(id)) continue;
    const hit = cache.get(id);
    if (hit && hit.until > now) {
      if (hit.charities.length) out.set(id, hit.charities);
      continue;
    }
    todo.push(id);
  }
  if (todo.length === 0) return out;
  const base = (process.env.DONATE_GG_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  await Promise.all(
    todo.map(async (id) => {
      try {
        const res = await fetch(`${base}/configs/${encodeURIComponent(id)}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status !== 200 && res.status !== 404) return;
        const charities = res.status === 200 ? charitiesFromDonateConfig(await res.json()) : [];
        cache.set(id, { charities, until: now + (charities.length ? CONFIG_OK_MS : CONFIG_MISS_MS) });
        if (charities.length) out.set(id, charities);
      } catch {
        // donate.gg didn't answer. The card keeps the address; the next read can try.
      }
    }),
  );
  if (cache.size > MAX_CACHED) {
    let extra = cache.size - MAX_CACHED;
    for (const key of cache.keys()) {
      if (extra-- <= 0) break;
      cache.delete(key);
    }
  }
  return out;
}

/** Test hook: forget every loaded config. */
export function clearDonateConfigCache(): void {
  cache.clear();
}

/**
 * The chain recipients with each donation PDA replaced by the charities on its donate.gg
 * config. One config naming two charities becomes two recipients, each with its part of the
 * PDA's share. A recipient whose config was not loaded stays as it was.
 */
export function expandCharityRecipients(
  chain: readonly ParsedFeeRecipient[],
  configs: ReadonlyMap<string, DonateCharity[]>,
): ParsedFeeRecipient[] {
  return chain.flatMap((recipient) => {
    const charities = recipient.configId ? configs.get(recipient.configId) : undefined;
    if (!charities?.length) return [recipient];
    return charities.map((charity) => ({
      label: charity.name,
      bps: recipient.bps == null ? null : Math.round((recipient.bps * charity.bps) / 10_000),
      kind: "charity",
      named: true,
      address: recipient.address,
      configId: recipient.configId,
    }));
  });
}
