import { useEffect, useMemo, useRef, useState } from "react";
import { CloseIcon, SearchIcon } from "../components/Icons";
import { usePolling } from "../hooks";
import { pct } from "../format";
import { useWalletNames } from "../walletNames";
import { Load, Table, Tag, Wallet, n, when } from "./adminShared";

/**
 * The Admin Wallets section's "Bots and removed sides" modal (user ask 2026-10-17): the wallets the
 * Side Wallet Checker reads as bots, and the KOL side labels taken from them or never given to them
 * (GET /admin/wallets/bots, written hourly by the worker's kolSideWalletsJob.ts).
 */

export type BotReason = "marked" | "bot" | "likelyBot";
export type RemovalReason = BotReason | "service";

export interface SideBotsResponse {
  computedAt: string | null;
  rules: {
    bot: { minCoins: number; minPct: number; days: number };
    likelyBot: { minKols: number; minPct: number; minShared: number; window: string };
    holdDays: number;
  };
  botCount: number;
  removalCount: number;
  bots: {
    wallet: string;
    reason: BotReason;
    coins30d: number | null;
    coinShare: number | null;
    kols: { wallet: string; name: string | null }[];
    removedLabels: number;
    firstSeenAt: string;
    computedAt: string;
  }[];
  removals: {
    wallet: string;
    kolWallet: string;
    kolName: string | null;
    reason: RemovalReason;
    /** A label it carried was deleted; otherwise it met a tier but was never given one. */
    held: boolean;
    pct: number;
    shared: number;
    kolCoins: number;
    hours: number;
    transfers: number;
    firstAt: string;
    lastAt: string;
  }[];
}

export type SideBotsView = "all" | "bots" | "removed" | "both";
const VIEWS: [SideBotsView, string][] = [
  ["all", "All"],
  ["bots", "Bots"],
  ["removed", "Removed sides"],
  ["both", "Both"],
];

const REASON_LABEL: Record<RemovalReason, string> = {
  marked: "Marked by hand",
  bot: "Bot",
  likelyBot: "Likely bot",
  service: "Service wallet",
};

export interface SideBotRow {
  wallet: string;
  bot: SideBotsResponse["bots"][number] | null;
  removals: SideBotsResponse["removals"];
  /** The newest time either record was written, for the order. */
  lastAt: string;
}

/**
 * One row a wallet: its bot record, if any, and the side labels removed from it. `view` keeps the
 * bots, the wallets with removed labels, or the bots that also lost labels; `query` matches the
 * wallet, or a KOL's name or wallet it was matched with. Newest first. Exported for tests.
 */
export function sideBotRows(data: SideBotsResponse, view: SideBotsView, query = ""): SideBotRow[] {
  const rows = new Map<string, SideBotRow>();
  for (const b of data.bots)
    rows.set(b.wallet, { wallet: b.wallet, bot: b, removals: [], lastAt: b.computedAt });
  for (const r of data.removals) {
    let row = rows.get(r.wallet);
    if (!row) rows.set(r.wallet, (row = { wallet: r.wallet, bot: null, removals: [], lastAt: r.lastAt }));
    row.removals.push(r);
    if (r.lastAt > row.lastAt) row.lastAt = r.lastAt;
  }
  const q = query.trim().toLowerCase();
  return [...rows.values()]
    .filter((row) =>
      view === "bots"
        ? row.bot !== null
        : view === "removed"
          ? row.removals.length > 0
          : view === "both"
            ? row.bot !== null && row.removals.length > 0
            : true,
    )
    .filter(
      (row) =>
        !q ||
        row.wallet.toLowerCase().includes(q) ||
        (row.bot?.kols ?? []).some(
          (k) => k.wallet.toLowerCase().includes(q) || k.name?.toLowerCase().includes(q),
        ) ||
        row.removals.some(
          (r) => r.kolWallet.toLowerCase().includes(q) || r.kolName?.toLowerCase().includes(q),
        ),
    )
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.wallet.localeCompare(b.wallet)));
}

/** What earned the label it lost: "60% of 20 coins in 24h", "8 transfers in 24h", or both. */
export function labelFigures(
  r: Pick<SideBotsResponse["removals"][number], "pct" | "shared" | "kolCoins" | "hours" | "transfers">,
): string {
  const parts: string[] = [];
  if (r.shared > 0) parts.push(`${pct(r.pct, 0)} of ${n(r.kolCoins)} coins`);
  if (r.transfers > 0) parts.push(`${n(r.transfers)} transfers`);
  return `${parts.join(", ") || "no figures"} in ${r.hours}h`;
}

const reasonTag = (reason: RemovalReason) => (
  <Tag tone={reason === "service" ? "muted" : reason === "likelyBot" ? "warn" : "bad"}>
    {REASON_LABEL[reason]}
  </Tag>
);
const kolName = (wallet: string, name: string | null) => name ?? `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

export function SideBotsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal side-bots-modal"
      aria-labelledby="side-bots-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="side-bots-title">Bots and removed sides</h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        {open && <SideBotsBody />}
      </div>
    </dialog>
  );
}

function SideBotsBody() {
  const q = usePolling<SideBotsResponse>("/admin/wallets/bots", 300_000);
  const [view, setView] = useState<SideBotsView>("all");
  const [query, setQuery] = useState("");
  const rows = useMemo(() => (q.data ? sideBotRows(q.data, view, query) : []), [q.data, view, query]);
  const names = useWalletNames(useMemo(() => rows.map((r) => r.wallet), [rows]));
  return (
    <Load q={q}>
      {(d) => (
        <div className="stack">
          <p className="muted small">
            Bots are left off every KOL's side list and never carry a side label. A bot buys at least{" "}
            {n(d.rules.bot.minCoins)} tracked coins and over {d.rules.bot.minPct}% of every tracked coin in{" "}
            {d.rules.bot.days} days; a likely bot shares over {d.rules.likelyBot.minShared} coins at over{" "}
            {d.rules.likelyBot.minPct}% with {d.rules.likelyBot.minKols}+ KOLs over {d.rules.likelyBot.window}
            . Removed means a side label it held was deleted; withheld means it met a label tier but was never
            given one. Read hourly, last {when(d.computedAt)}; bots kept 30 days and removals{" "}
            {d.rules.holdDays} days past their last read.
          </p>
          <div className="row side-bots-filters">
            <div className="segmented small" role="group" aria-label="Show">
              {VIEWS.map(([id, label]) => (
                <button
                  key={id}
                  className={view === id ? "on" : ""}
                  aria-pressed={view === id}
                  onClick={() => setView(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="side-search">
              <SearchIcon size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Wallet or KOL"
                aria-label="Search by wallet or KOL"
                spellCheck={false}
              />
            </label>
          </div>
          <p className="muted small">
            {n(d.botCount)} bots · {n(d.removalCount)} side labels removed or withheld · showing{" "}
            {n(rows.length)}
            {d.botCount > d.bots.length || d.removalCount > d.removals.length ? " (newest 500 of each)" : ""}
          </p>
          <Table
            head={[
              "Wallet",
              "Read as",
              "Coins, 30d",
              "Matched KOLs",
              "Side labels removed",
              "First flagged",
              "Last read",
            ]}
            rows={rows.map((r) => [
              <Wallet key="w" address={r.wallet} names={names} />,
              r.bot ? reasonTag(r.bot.reason) : r.removals[0] ? reasonTag(r.removals[0].reason) : "–",
              r.bot?.coins30d != null ? (
                <span key="c">
                  {n(r.bot.coins30d)}
                  {r.bot.coinShare != null && (
                    <span className="faint"> ({pct(r.bot.coinShare * 100, 0)} of all)</span>
                  )}
                </span>
              ) : (
                "–"
              ),
              r.bot?.kols.length ? (
                <span key="k" title={r.bot.kols.map((k) => kolName(k.wallet, k.name)).join(", ")}>
                  {r.bot.kols
                    .slice(0, 3)
                    .map((k) => kolName(k.wallet, k.name))
                    .join(", ")}
                  {r.bot.kols.length > 3 && <span className="faint"> +{r.bot.kols.length - 3}</span>}
                </span>
              ) : (
                "–"
              ),
              r.removals.length ? (
                <ul key="r" className="side-bots-removals">
                  {r.removals.map((x) => (
                    <li key={x.kolWallet}>
                      <Tag tone={x.held ? "bad" : "muted"}>{x.held ? "removed" : "withheld"}</Tag>{" "}
                      {kolName(x.kolWallet, x.kolName)} <span className="faint">{labelFigures(x)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                "–"
              ),
              when(r.bot?.firstSeenAt ?? r.removals.map((x) => x.firstAt).sort()[0]),
              when(r.lastAt),
            ])}
            empty={
              d.botCount + d.removalCount === 0
                ? "Nothing recorded yet: the side wallet rebuild writes this each hour."
                : "No wallet matches."
            }
          />
        </div>
      )}
    </Load>
  );
}
