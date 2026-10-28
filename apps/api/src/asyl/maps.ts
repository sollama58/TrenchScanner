import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@trenchscanner/core";

/**
 * Saved Asyl maps (user ask 2026-10-24): what was on the map, where each bubble sat, and the
 * user's notes. A map reopens around the same wallets with fresh data; its public link (user
 * decision 2026-10-24: read-only snapshots) serves the copy frozen when it was shared, to anyone,
 * and never reads the chain or any table but this one.
 */

/** Maps one account keeps. */
export const MAPS_PER_USER = 100;
/** Room for a coin with all its historical holders and their links (user report 2026-10-25). */
export const MAP_NODES_MAX = 1_500;
export const MAP_EDGES_MAX = 6_000;
export const MAP_TITLE_MAX = 80;
export const MAP_NOTE_MAX = 2_000;
/** The body a save may send: a full map with its layout. */
export const MAP_BODY_LIMIT = 4_000_000;
/**
 * Bytes one account's maps may hold, their shared copies included (user decision 2026-10-27, full
 * audit TR-3): about 20 MB for a free account, so one sign-in can't fill the database with 100
 * maps of 8 MB each. Pro Mode keeps more.
 */
export const MAP_BYTES_FREE = 20_000_000;
export const MAP_BYTES_PRO = 200_000_000;

/** A doc's size as stored, near enough: its JSON's bytes. */
export const docBytes = (doc: unknown) => Buffer.byteLength(JSON.stringify(doc));

type Tx = Prisma.TransactionClient;

/**
 * Runs `fn` with the account's maps locked against its other saves (a transaction-scoped advisory
 * lock on the user), handing it what the account's maps hold now leaving out `leaveOut`'s doc or
 * shared copy, the part the write replaces.
 */
async function withBytes<T>(
  userId: string,
  leaveOut: { id: string; part: "doc" | "shared" } | null,
  fn: (tx: Tx, held: number) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`asyl-maps:${userId}`}))`;
    const rows = await tx.asylMap.findMany({
      where: { userId },
      select: { id: true, docBytes: true, sharedBytes: true },
    });
    const held = rows.reduce(
      (a, r) =>
        a +
        (leaveOut?.id === r.id && leaveOut.part === "doc" ? 0 : r.docBytes) +
        (leaveOut?.id === r.id && leaveOut.part === "shared" ? 0 : r.sharedBytes),
      0,
    );
    return fn(tx, held);
  });
}

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const finite = z.number().finite();
const tag = z.string().max(16);
/**
 * Text the map's reads wrote, cut to fit rather than refused: one long coin name must not stop a
 * whole map from saving. A link too long to keep is dropped, as half a URL is no picture.
 */
const clipped = (max: number) => z.string().transform((v) => v.slice(0, max));
const url = (max: number) => z.string().transform((v) => (v.length <= max ? v : null));

const nodeSchema = z.object({
  id: address,
  kind: z.enum(["wallet", "token"]),
  name: clipped(80).nullable(),
  tags: z.array(tag).max(12),
  risk: finite.nullable().optional(),
  win: finite.nullable().optional(),
  coins: finite.nullable().optional(),
  medianPnlSol: finite.nullable().optional(),
  avatar: url(200).nullable().optional(),
  title: clipped(120).nullable().optional(),
  image: url(1000).nullable().optional(),
  mcapUsd: finite.nullable().optional(),
  mcapAt: z.string().max(40).nullable().optional(),
  athUsd: finite.nullable().optional(),
  launchedAt: z.string().max(40).nullable().optional(),
  deployer: address.nullable().optional(),
  deployerVerified: z.boolean().nullable().optional(),
});

const edgeSchema = z.object({
  a: address,
  b: address,
  kind: z.enum(["funded", "transfer", "cotrade", "side", "created", "holds", "traded"]),
  weight: finite,
  label: clipped(160),
  source: z.enum(["stored", "chain"]),
  mint: address.nullable().optional(),
  at: z.string().max(40).nullable().optional(),
  sol: finite.nullable().optional(),
  tokens: finite.nullable().optional(),
  pct: finite.nullable().optional(),
  shared: finite.nullable().optional(),
  of: finite.nullable().optional(),
  gapSec: finite.nullable().optional(),
  leadSec: finite.nullable().optional(),
  from: address.nullable().optional(),
  net: finite.nullable().optional(),
});

/** The least a money link must carry to be drawn; 0 draws them all. */
const cutoffsSchema = z.object({
  sol: finite.min(0).default(0),
  usd: finite.min(0).default(0),
  tokens: finite.min(0).default(0),
  pct: finite.min(0).default(0),
  /** "Bought together" links: the fewest coins in common, and the most median seconds apart. */
  shared: finite.min(0).default(0),
  gap: finite.min(0).default(0),
  /** Who buys first on those links: 0 either, 1 the co-trader, 2 the wallet it was found from. */
  first: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
});

/** What the reader drew on the map: labelled lines between two bubbles, text boxes, and pen strokes. */
const drawColour = z.string().regex(/^#[0-9a-f]{6}$/);
const drawingsSchema = z.object({
  lines: z
    .array(
      z.object({
        id: z.string().min(1).max(16),
        a: address,
        b: address,
        label: z.string().max(80),
        colour: drawColour,
      }),
    )
    .max(200)
    .default([]),
  texts: z
    .array(
      z.object({
        id: z.string().min(1).max(16),
        x: finite,
        y: finite,
        text: z.string().max(400),
        colour: drawColour,
      }),
    )
    .max(100)
    .default([]),
  /** Freehand pen strokes (user ask 2026-10-25), in map units, as the web's thinStroke keeps them. */
  strokes: z
    .array(
      z.object({
        id: z.string().min(1).max(16),
        points: z
          .array(z.tuple([finite, finite]))
          .min(1)
          .max(500),
        colour: drawColour,
        width: finite.min(0.05).max(400),
      }),
    )
    .max(200)
    .default([]),
});

export const mapDocSchema = z.object({
  v: z.literal(1),
  nodes: z.array(nodeSchema).max(MAP_NODES_MAX),
  edges: z.array(edgeSchema).max(MAP_EDGES_MAX),
  /** Where each bubble sat, by node id. */
  positions: z.record(z.string(), z.tuple([finite, finite])),
  /** Notes pinned to nodes, by node id. */
  notes: z.record(z.string(), z.string().max(MAP_NOTE_MAX)).default({}),
  /** The map's own note, shown above it. */
  note: z.string().max(MAP_NOTE_MAX).default(""),
  /** Hidden edge kinds when it was saved. */
  hidden: z.array(z.string().max(16)).max(10).default([]),
  /** Kinds of link switched off for one wallet only (user ask 2026-10-25), by wallet. */
  walletHidden: z.record(address, z.array(z.string().max(16)).max(10)).optional(),
  /** Bubbles no drawn link reaches leave the map; off, every bubble stays. */
  hideLoose: z.boolean().optional(),
  /** Nodes the user took off the map: kept in it, so they can be brought back one by one. */
  removed: z.array(address).max(MAP_NODES_MAX).default([]),
  /** Single links the user hid, by "kind|a|b|mint" (the web's edgeKey). */
  cut: z.array(z.string().max(160)).max(MAP_EDGES_MAX).default([]),
  /** The reader's own lines and text boxes. */
  drawings: drawingsSchema.optional(),
  /** The amount sliders when it was saved. */
  cutoffs: cutoffsSchema.optional(),
  /** Bubbles the user placed by hand, which the layout leaves where they are. */
  pinned: z.array(address).max(MAP_NODES_MAX).optional(),
  /** Grid mode: each bubble on its own cell. */
  grid: z.boolean().optional(),
  /** Analyst Mode: drawn as a flowchart of boxes and right-angled lines. */
  analyst: z.boolean().optional(),
  /** Which kinds of line carry their time. */
  times: z.object({ funded: z.boolean(), created: z.boolean(), transfer: z.boolean() }).optional(),
  /** The node it was opened around. */
  focus: address.nullable().default(null),
});
export type AsylMapDoc = z.infer<typeof mapDocSchema>;

export const saveSchema = z.object({
  title: z.string().trim().min(1).max(MAP_TITLE_MAX),
  doc: mapDocSchema,
});

/** Every position and note must belong to a node on the map, and every edge join two of them. */
export function cleanDoc(doc: AsylMapDoc): AsylMapDoc {
  const ids = new Set(doc.nodes.map((n) => n.id));
  return {
    ...doc,
    edges: doc.edges.filter((e) => ids.has(e.a) && ids.has(e.b)),
    positions: Object.fromEntries(Object.entries(doc.positions).filter(([id]) => ids.has(id))),
    ...(doc.pinned ? { pinned: doc.pinned.filter((id) => ids.has(id)) } : {}),
    notes: Object.fromEntries(Object.entries(doc.notes).filter(([id, note]) => ids.has(id) && note.trim())),
    ...(doc.drawings
      ? {
          drawings: {
            ...doc.drawings,
            lines: doc.drawings.lines.filter((l) => ids.has(l.a) && ids.has(l.b)),
          },
        }
      : {}),
  };
}

/** The copy a public link serves: what the user took off the map is left out of it altogether. */
export function publicDoc(doc: AsylMapDoc): AsylMapDoc {
  const removed = new Set(doc.removed ?? []);
  // Links the owner hid one by one leave the shared copy too.
  const cut = new Set(doc.cut ?? []);
  if (removed.size === 0 && cut.size === 0) return doc;
  return cleanDoc({
    ...doc,
    nodes: doc.nodes.filter((n) => !removed.has(n.id)),
    edges: doc.edges.filter((e) => !cut.has(`${e.kind}|${e.a}|${e.b}|${e.mint ?? ""}`)),
    removed: [],
    cut: [],
  });
}

export interface MapSummary {
  id: string;
  title: string;
  nodes: number;
  shareSlug: string | null;
  sharedAt: string | null;
  updatedAt: string;
}

const summary = (row: {
  id: string;
  title: string;
  doc: Prisma.JsonValue;
  shareSlug: string | null;
  sharedAt: Date | null;
  updatedAt: Date;
}): MapSummary => ({
  id: row.id,
  title: row.title,
  nodes: Array.isArray((row.doc as { nodes?: unknown } | null)?.nodes)
    ? (row.doc as { nodes: unknown[] }).nodes.length
    : 0,
  shareSlug: row.shareSlug,
  sharedAt: row.sharedAt?.toISOString() ?? null,
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * The reader's maps, newest first. Each one's size is counted in the database: a list of up to
 * MAPS_PER_USER maps never reads their whole documents (up to MAP_BODY_LIMIT each) to count them.
 */
export async function listMaps(userId: string): Promise<MapSummary[]> {
  const rows = await prisma.$queryRaw<
    {
      id: string;
      title: string;
      nodes: number;
      shareSlug: string | null;
      sharedAt: Date | null;
      updatedAt: Date;
    }[]
  >`
    SELECT "id", "title",
           CASE WHEN jsonb_typeof("doc"->'nodes') = 'array' THEN jsonb_array_length("doc"->'nodes') ELSE 0 END::int AS nodes,
           "shareSlug", "sharedAt", "updatedAt"
      FROM "AsylMap"
     WHERE "userId" = ${userId}
     ORDER BY "updatedAt" DESC
     LIMIT ${MAPS_PER_USER}`;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    nodes: r.nodes,
    shareSlug: r.shareSlug,
    sharedAt: r.sharedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function readMap(userId: string, id: string) {
  const row = await prisma.asylMap.findFirst({ where: { id, userId } });
  if (!row) return null;
  return { ...summary(row), doc: row.doc as unknown as AsylMapDoc };
}

export async function createMap(userId: string, title: string, doc: AsylMapDoc, byteCap = MAP_BYTES_FREE) {
  const clean = cleanDoc(doc);
  const bytes = docBytes(clean);
  return withBytes(userId, null, async (tx, held) => {
    const count = await tx.asylMap.count({ where: { userId } });
    if (count >= MAPS_PER_USER) return { error: "cap" as const };
    if (held + bytes > byteCap) return { error: "bytes" as const, held };
    const row = await tx.asylMap.create({
      data: { userId, title, doc: clean as unknown as Prisma.InputJsonValue, docBytes: bytes },
    });
    return { map: summary(row) };
  });
}

/** Saves over a map: "ok", "missing" when it isn't the reader's, "bytes" past the account's cap. */
export async function updateMap(
  userId: string,
  id: string,
  title: string,
  doc: AsylMapDoc,
  byteCap = MAP_BYTES_FREE,
): Promise<"ok" | "missing" | "bytes"> {
  const clean = cleanDoc(doc);
  const bytes = docBytes(clean);
  return withBytes(userId, { id, part: "doc" }, async (tx, held) => {
    if (held + bytes > byteCap) {
      const mine = await tx.asylMap.count({ where: { id, userId } });
      return mine > 0 ? "bytes" : "missing";
    }
    const res = await tx.asylMap.updateMany({
      where: { id, userId },
      data: { title, doc: clean as unknown as Prisma.InputJsonValue, docBytes: bytes },
    });
    return res.count > 0 ? "ok" : "missing";
  });
}

export async function deleteMap(userId: string, id: string): Promise<boolean> {
  const res = await prisma.asylMap.deleteMany({ where: { id, userId } });
  return res.count > 0;
}

/** A slug for the public link: 12 characters, about 71 bits, never guessable. */
export function newSlug(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(12);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/**
 * Freezes the map as it stands now behind its link (the same link when it had one). Refused when
 * an admin took its link down, or when the copy would take the account past its byte cap.
 */
export async function shareMap(
  userId: string,
  id: string,
  byteCap = MAP_BYTES_FREE,
): Promise<{ slug: string } | { error: "taken-down" } | { error: "bytes"; held: number } | null> {
  return withBytes(userId, { id, part: "shared" }, async (tx, held) => {
    const row = await tx.asylMap.findFirst({
      where: { id, userId },
      select: { doc: true, shareSlug: true, takenDownAt: true },
    });
    if (!row) return null;
    if (row.takenDownAt) return { error: "taken-down" as const };
    const shared = publicDoc(row.doc as unknown as AsylMapDoc);
    const bytes = docBytes(shared);
    if (held + bytes > byteCap) return { error: "bytes" as const, held };
    const slug = row.shareSlug ?? newSlug();
    await tx.asylMap.update({
      where: { id },
      data: {
        shareSlug: slug,
        sharedDoc: shared as unknown as Prisma.InputJsonValue,
        sharedBytes: bytes,
        sharedAt: new Date(),
      },
    });
    return { slug };
  });
}

export async function unshareMap(userId: string, id: string): Promise<boolean> {
  const res = await prisma.asylMap.updateMany({
    where: { id, userId },
    data: { shareSlug: null, sharedDoc: Prisma.DbNull, sharedAt: null, sharedBytes: 0 },
  });
  return res.count > 0;
}

/** A shared map as an admin's list shows it. */
export interface SharedMapRow {
  slug: string | null;
  title: string;
  owner: string;
  nodes: number;
  sharedAt: string | null;
  takenDownAt: string | null;
}

/** Shared maps, newest first, and the ones taken down, for an admin (full audit 2026-10-27, TR-2). */
export async function listSharedMaps(limit = 200): Promise<SharedMapRow[]> {
  const rows = await prisma.$queryRaw<
    {
      shareSlug: string | null;
      title: string;
      owner: string;
      nodes: number;
      sharedAt: Date | null;
      takenDownAt: Date | null;
    }[]
  >`
    SELECT m."shareSlug", m."title", u."walletAddress" AS owner,
           CASE WHEN jsonb_typeof(m."sharedDoc"->'nodes') = 'array' THEN jsonb_array_length(m."sharedDoc"->'nodes') ELSE 0 END::int AS nodes,
           m."sharedAt", m."takenDownAt"
      FROM "AsylMap" m JOIN "User" u ON u."id" = m."userId"
     WHERE m."shareSlug" IS NOT NULL OR m."takenDownAt" IS NOT NULL
     ORDER BY COALESCE(m."sharedAt", m."takenDownAt") DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    slug: r.shareSlug,
    title: r.title,
    owner: r.owner,
    nodes: r.nodes,
    sharedAt: r.sharedAt?.toISOString() ?? null,
    takenDownAt: r.takenDownAt?.toISOString() ?? null,
  }));
}

/**
 * An admin takes a shared map's link down: the link stops answering, the frozen copy goes, and the
 * owner can't share it again. The owner keeps the map itself. False when no map has that link.
 */
export async function takeDownShared(slug: string): Promise<boolean> {
  const res = await prisma.asylMap.updateMany({
    where: { shareSlug: slug },
    data: {
      shareSlug: null,
      sharedDoc: Prisma.DbNull,
      sharedAt: null,
      sharedBytes: 0,
      takenDownAt: new Date(),
    },
  });
  return res.count > 0;
}

export async function readShared(slug: string) {
  const row = await prisma.asylMap.findUnique({
    where: { shareSlug: slug },
    select: { title: true, sharedDoc: true, sharedAt: true },
  });
  if (!row?.sharedDoc) return null;
  return {
    title: row.title,
    sharedAt: row.sharedAt?.toISOString() ?? null,
    doc: row.sharedDoc as unknown as AsylMapDoc,
  };
}
