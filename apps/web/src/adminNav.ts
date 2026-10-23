/** Admin sections and the hash that opens one. `#admin/training` still opens Models + Training. */

export const ADMIN_SECTIONS = [
  {
    id: "overview",
    label: "Overview",
    group: "Operations",
    blurb: "Counts, subscriptions and what changed recently.",
  },
  {
    id: "worker",
    label: "Worker",
    group: "Operations",
    blurb: "Heartbeats and running a scheduled job early.",
  },
  { id: "alerts", label: "Alerts", group: "Operations", blurb: "Recent model alerts and how they graded." },
  { id: "api", label: "API", group: "Operations", blurb: "This API process: uptime, memory and routes." },
  { id: "usage", label: "API usage", group: "Operations", blurb: "Outside calls and Helius credits." },
  { id: "config", label: "Config", group: "Operations", blurb: "The env the API booted with." },
  {
    id: "env",
    label: "Environment",
    group: "Operations",
    blurb: "Which env vars each service has set, TokenSage's too. Never the values.",
  },
  {
    id: "models",
    label: "Models + Training",
    group: "Models",
    blurb: "Every seat, what it was fit on, and the trainer.",
  },
  { id: "wallets", label: "Wallets", group: "Scanning", blurb: "Wallet risk, coins and stop causes." },
  {
    id: "tokensage",
    label: "TokenSage",
    group: "Scanning",
    blurb: "Stored narrative reads and how they went.",
  },
  { id: "screen", label: "Safety screen", group: "Scanning", blurb: "What the screen rejected, and why." },
  { id: "filters", label: "Filters", group: "Scanning", blurb: "Every saved filter and its recent hits." },
  {
    id: "feedsim",
    label: "Feed simulator",
    group: "Scanning",
    blurb: "Hit rate and coverage for a mix of models and filters.",
  },
  { id: "users", label: "Users", group: "People", blurb: "Accounts and when they were last seen." },
  { id: "access", label: "Access", group: "People", blurb: "Subscriptions, grants and the whitelist." },
  { id: "credits", label: "Burn Credits", group: "People", blurb: "Prices, grants and the ledger." },
  { id: "announce", label: "Announcements", group: "People", blurb: "The bar at the top of the dashboard." },
  { id: "reports", label: "Reports", group: "People", blurb: "Bug reports from the dashboard." },
  { id: "ai", label: "AI", group: "AI", blurb: "The reviewer switch, spend and recent reviews." },
  { id: "bot", label: "Trading bot", group: "Trading", blurb: "The bot's positions, config and controls." },
  {
    id: "backups",
    label: "Backups",
    group: "Data",
    blurb: "Model snapshots, database dumps and the action log.",
  },
  { id: "database", label: "Database", group: "Data", blurb: "Live queries, locks and where the disk goes." },
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number]["id"];

const IDS = new Set<string>(ADMIN_SECTIONS.map((s) => s.id));

export function adminSectionMeta(id: AdminSection) {
  return ADMIN_SECTIONS.find((s) => s.id === id) ?? ADMIN_SECTIONS[0];
}

/** True when this hash is the admin tab (`#admin`, `#admin/models`, or the old `#trading`). */
export function isAdminHash(hash: string): boolean {
  const h = hash.replace(/^#/, "");
  return h === "admin" || h.startsWith("admin/") || h === "trading";
}

/** The section an admin hash opens. Anything else is Overview. */
export function adminSectionFromHash(hash: string): AdminSection {
  const h = hash.replace(/^#/, "");
  if (h === "trading") return "bot";
  const rest = h.startsWith("admin/") ? h.slice("admin/".length) : "";
  const id = rest.split(/[/?#]/)[0] || "overview";
  if (id === "training") return "models";
  return IDS.has(id) ? (id as AdminSection) : "overview";
}

export function adminHashFor(id: AdminSection): string {
  return id === "overview" ? "#admin" : `#admin/${id}`;
}

export function adminGroups(): { group: string; items: (typeof ADMIN_SECTIONS)[number][] }[] {
  const groups: { group: string; items: (typeof ADMIN_SECTIONS)[number][] }[] = [];
  for (const section of ADMIN_SECTIONS) {
    const last = groups[groups.length - 1];
    if (!last || last.group !== section.group) groups.push({ group: section.group, items: [section] });
    else last.items.push(section);
  }
  return groups;
}
