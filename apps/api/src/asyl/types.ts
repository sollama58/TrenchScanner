/**
 * Asyl's map (asyl.trenchscanner.app, user ask 2026-10-24): wallets and coins as nodes, and what
 * links them as typed edges. Every read under /asyl answers with an AsylGraph around what was
 * asked about; the web app merges each answer into the map on screen (apps/web/src/asyl/graph.ts
 * keeps the same shapes).
 */

export type AsylNodeKind = "wallet" | "token";

/**
 * A short label on a node. "mine": the reader's own label (Pro Mode, trackedWallets.ts); the rest
 * are TrenchScanner's: the KOL roster and its sides, exchanges and launchpads, a creator, the
 * hourly wallet scores' dumper / winner / sniper, a bot, a fresh-per-launch dev farm's funder.
 */
export type AsylTag =
  | "mine"
  | "kol"
  | "kol-side"
  | "exchange"
  | "dev"
  | "dumper"
  | "winner"
  | "sniper"
  | "risky"
  | "bot"
  | "farm";

export interface AsylNode {
  id: string;
  kind: AsylNodeKind;
  /** The name it goes by: the reader's label, a KOL, an exchange, Helius's name, or a coin's ticker. */
  name: string | null;
  tags: AsylTag[];
  /** Wallets: the hourly risk score (0-100, higher is riskier) and win score, when it has them. */
  risk?: number | null;
  win?: number | null;
  /** Wallets: tracked coins it bought (WalletRisk.appearances). */
  coins?: number | null;
  /** Wallets: realised profit per coin, median, in SOL. */
  medianPnlSol?: number | null;
  /** A KOL's X picture, as a path on the API. */
  avatar?: string | null;
  /** Coins: full name, picture, market cap now and its peak since its first alert. */
  title?: string | null;
  image?: string | null;
  mcapUsd?: number | null;
  /** When the market cap was read. */
  mcapAt?: string | null;
  athUsd?: number | null;
  launchedAt?: string | null;
  /** Coins: the wallet that deployed it (Token.creator), when TrenchScanner knows it. */
  deployer?: string | null;
  /** Whether `deployer` was read off the create transaction (else it is Pump.fun's or RugCheck's `creator`, which a takeover can move). */
  deployerVerified?: boolean | null;
}

/**
 * funded: the first SOL into `b` came from `a` (WalletFunder). transfer: `a` sent `b` SOL or a coin
 * (holder transfers, or a Pro flow read). cotrade: both bought the same coins within minutes of
 * each other. side: `b` is `a`'s Known Side, Probable Side or a side of the reader's own label.
 * created: `a` launched coin `b`. holds: `a` holds `pct`% of coin `b`. traded: `a` bought or sold
 * coin `b`.
 */
export type AsylEdgeKind = "funded" | "transfer" | "cotrade" | "side" | "created" | "holds" | "traded";

export interface AsylEdge {
  a: string;
  b: string;
  kind: AsylEdgeKind;
  /** How strong: SOL paid or moved, coins shared, % held or % shared; the map scales lines by it. */
  weight: number;
  /** One line for the edge's hover: "Funded 1.2 SOL · 3 Oct", "Sent 0.4% of supply · 2×". */
  label: string;
  /** Where it was read: TrenchScanner's tables, or a chain read this map paid for. */
  source: "stored" | "chain";
  /** A coin edge's coin, or a transfer's coin (null for SOL). */
  mint?: string | null;
  at?: string | null;
  /** SOL paid, moved or traded, when the link is money; the map's amount sliders read these. */
  sol?: number | null;
  /** Coins moved, for a coin transfer read from the chain. */
  tokens?: number | null;
  /** % of the coin's supply held or moved. */
  pct?: number | null;
  /** A "bought together" link: coins both bought within minutes, of the coins read, and the median seconds apart. */
  shared?: number | null;
  of?: number | null;
  gapSec?: number | null;
  /** ...and who usually bought first: median seconds from `a`'s first buy to `b`'s, negative when `b` led. */
  leadSec?: number | null;
}

export interface AsylGraph {
  nodes: AsylNode[];
  edges: AsylEdge[];
}

/** What a read covers, so a missing link is never read as no link. */
export interface AsylCoverage {
  /** Tracked coins this wallet was seen buying (30 days), or holders read for a coin. */
  seen: number;
  /** The span of stored data, in days. */
  days: number;
  /** Whether a chain read (Pro) would add to it. */
  chainAvailable: boolean;
  note: string;
}
