import {
  TAG_LABEL,
  edgeKey,
  nodeName,
  shortAddr,
  type AsylEdge,
  type AsylGraph,
  type AsylNode,
} from "./graph";

/**
 * Exports past CSV (user ask 2026-10-26): the map as JSON for other tools, a written report to post
 * or file, and what changed against a saved map.
 */

/** The map as JSON: every wallet and coin with what Asyl knows of it, and every link. */
export function graphJson(
  g: AsylGraph,
  meta: { title: string; note?: string; notes?: Record<string, string> },
): string {
  return (
    JSON.stringify(
      {
        title: meta.title,
        exportedAt: new Date().toISOString(),
        note: meta.note || undefined,
        nodes: g.nodes.map((n) => ({ ...n, note: meta.notes?.[n.id] || undefined })),
        edges: g.edges,
      },
      null,
      2,
    ) + "\n"
  );
}

export interface GraphDiff {
  newNodes: AsylNode[];
  goneNodes: AsylNode[];
  newEdges: AsylEdge[];
  goneEdges: AsylEdge[];
}

/** What the map on screen has that a saved one didn't, and what the saved one had that's gone. */
export function diffGraphs(now: AsylGraph, then: AsylGraph): GraphDiff {
  const thenNodes = new Set(then.nodes.map((n) => n.id));
  const nowNodes = new Set(now.nodes.map((n) => n.id));
  const thenEdges = new Set(then.edges.map(edgeKey));
  const nowEdges = new Set(now.edges.map(edgeKey));
  return {
    newNodes: now.nodes.filter((n) => !thenNodes.has(n.id)),
    goneNodes: then.nodes.filter((n) => !nowNodes.has(n.id)),
    newEdges: now.edges.filter((e) => !thenEdges.has(edgeKey(e))),
    goneEdges: then.edges.filter((e) => !nowEdges.has(edgeKey(e))),
  };
}

/** A diff in a line. */
export function diffNote(d: GraphDiff, title: string): string {
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    d.newNodes.length ? `${count(d.newNodes.length, "bubble")} new` : null,
    d.goneNodes.length ? `${count(d.goneNodes.length, "bubble")} gone` : null,
    d.newEdges.length ? `${count(d.newEdges.length, "link")} new` : null,
    d.goneEdges.length ? `${count(d.goneEdges.length, "link")} gone` : null,
  ].filter(Boolean);
  return parts.length
    ? `Against "${title}": ${parts.join(", ")}.`
    : `Same wallets, coins and links as "${title}".`;
}

const usd = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "–"
    : n >= 1e6
      ? `$${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `$${(n / 1e3).toFixed(0)}K`
        : `$${n.toFixed(0)}`;
const sol = (n: number) => `${n >= 100 ? n.toFixed(0) : n.toFixed(2)} SOL`;
const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : null;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const solscan = (n: AsylNode) => `https://solscan.io/${n.kind === "token" ? "token" : "account"}/${n.id}`;

/**
 * The report builder (user ask 2026-10-26): the map as a write-up an investigator can post or file,
 * in Markdown. Who is on it, the coins, where the money moved, the groups one funder paid, the
 * reader's own notes, and every address with its explorer link.
 */
export function writeUp(
  g: AsylGraph,
  meta: { title: string; note?: string; notes?: Record<string, string>; focus?: string | null; now?: Date },
): string {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const name = (id: string) => {
    const n = byId.get(id);
    return n ? (n.name ?? shortAddr(n.id)) : shortAddr(id);
  };
  const wallets = g.nodes.filter((n) => n.kind === "wallet");
  const coins = g.nodes.filter((n) => n.kind === "token");
  const when = (meta.now ?? new Date()).toISOString().slice(0, 10);
  const out: string[] = [`# ${meta.title}`, ""];
  out.push(
    `Made with Asyl on ${when}: ${plural(wallets.length, "wallet")}, ${plural(coins.length, "coin")}, ${plural(g.edges.length, "link")}.` +
      (meta.focus && byId.has(meta.focus) ? ` Started from ${nodeName(byId.get(meta.focus)!)}.` : ""),
    "",
  );
  if (meta.note?.trim()) out.push("## Summary", "", meta.note.trim(), "");

  // Who is on it, by tag.
  const tagged = (
    ["kol", "dev", "exchange", "fresh", "sniper", "dumper", "risky", "farm", "winner", "bot"] as const
  )
    .map((t) => ({ t, ws: wallets.filter((w) => w.tags.includes(t)) }))
    .filter((x) => x.ws.length);
  if (tagged.length) {
    out.push("## Who's on the map", "");
    for (const { t, ws } of tagged)
      out.push(
        `- **${TAG_LABEL[t]}** (${ws.length}): ${ws
          .slice(0, 12)
          .map((w) => name(w.id))
          .join(", ")}${ws.length > 12 ? ", …" : ""}`,
      );
    out.push("");
  }

  if (coins.length) {
    out.push(
      "## Coins",
      "",
      "| Coin | Market cap | Peak | Wallets on the map |",
      "| --- | --- | --- | --- |",
    );
    for (const c of coins) {
      const touching = new Set(
        g.edges.filter((e) => e.b === c.id || e.a === c.id).map((e) => (e.a === c.id ? e.b : e.a)),
      );
      out.push(
        `| [${cell(nodeName(c))}](${solscan(c)}) | ${usd(c.mcapUsd)} | ${usd(c.athUsd)} | ${touching.size} |`,
      );
    }
    out.push("");
  }

  // The biggest money moves.
  const money = g.edges
    .filter((e) => (e.kind === "funded" || e.kind === "transfer") && typeof e.sol === "number" && e.sol > 0)
    .sort((a, b) => b.sol! - a.sol!)
    .slice(0, 15);
  if (money.length) {
    out.push("## Where the money moved", "");
    for (const e of money)
      out.push(
        `- ${name(e.a)} → ${name(e.b)}: ${sol(e.sol!)} (${e.kind === "funded" ? "first funding" : "transfer"}${
          day(e.at) ? `, ${day(e.at)}` : ""
        })`,
      );
    out.push("");
  }

  // Funders that paid two or more wallets on the map: the groups.
  const paid = new Map<string, string[]>();
  for (const e of g.edges) if (e.kind === "funded") paid.set(e.a, [...(paid.get(e.a) ?? []), e.b]);
  const groups = [...paid.entries()]
    .filter(([f, ws]) => ws.length >= 2 && !byId.get(f)?.tags.includes("exchange"))
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10);
  if (groups.length) {
    out.push("## Groups one wallet paid for", "");
    for (const [f, ws] of groups)
      out.push(
        `- ${name(f)} funded ${ws.length}: ${ws.slice(0, 10).map(name).join(", ")}${ws.length > 10 ? ", …" : ""}`,
      );
    out.push("");
  }

  const together = g.edges
    .filter((e) => e.kind === "cotrade")
    .sort((a, b) => (b.shared ?? 0) - (a.shared ?? 0));
  if (together.length) {
    out.push("## Bought together", "");
    for (const e of together.slice(0, 10)) out.push(`- ${name(e.a)} and ${name(e.b)}: ${e.label}`);
    out.push("");
  }

  const noted = Object.entries(meta.notes ?? {}).filter(([id, t]) => t.trim() && byId.has(id));
  if (noted.length) {
    out.push("## Notes", "");
    for (const [id, t] of noted) out.push(`- **${name(id)}**: ${t.trim()}`);
    out.push("");
  }

  out.push("## Addresses", "", "| Name | Address | Tags |", "| --- | --- | --- |");
  for (const n of [...coins, ...wallets])
    out.push(
      `| ${cell(n.name ?? (n.kind === "token" ? "Coin" : "Wallet"))} | [${n.id}](${solscan(n)}) | ${n.tags
        .map((t) => TAG_LABEL[t])
        .join(", ")} |`,
    );
  out.push("");
  return out.join("\n");
}
