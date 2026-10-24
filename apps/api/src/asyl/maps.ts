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
export const MAP_NODES_MAX = 400;
export const MAP_EDGES_MAX = 2_000;
export const MAP_TITLE_MAX = 80;
export const MAP_NOTE_MAX = 2_000;
/** The body a save may send: a full map with its layout. */
export const MAP_BODY_LIMIT = 1_000_000;

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const finite = z.number().finite();
const tag = z.string().max(16);

const nodeSchema = z.object({
  id: address,
  kind: z.enum(["wallet", "token"]),
  name: z.string().max(80).nullable(),
  tags: z.array(tag).max(12),
  risk: finite.nullable().optional(),
  win: finite.nullable().optional(),
  coins: finite.nullable().optional(),
  medianPnlSol: finite.nullable().optional(),
  avatar: z.string().max(200).nullable().optional(),
  title: z.string().max(120).nullable().optional(),
  image: z.string().max(500).nullable().optional(),
  mcapUsd: finite.nullable().optional(),
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
  label: z.string().max(160),
  source: z.enum(["stored", "chain"]),
  mint: address.nullable().optional(),
  at: z.string().max(40).nullable().optional(),
  sol: finite.nullable().optional(),
  tokens: finite.nullable().optional(),
  pct: finite.nullable().optional(),
});

/** The least a money link must carry to be drawn; 0 draws them all. */
const cutoffsSchema = z.object({
  sol: finite.min(0).default(0),
  usd: finite.min(0).default(0),
  tokens: finite.min(0).default(0),
  pct: finite.min(0).default(0),
});

/** What the reader drew on the map: their own labelled lines between two bubbles, and text boxes. */
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
  /** Nodes the user took off the map: kept in it, so they can be brought back one by one. */
  removed: z.array(address).max(MAP_NODES_MAX).default([]),
  /** Single links the user hid, by "kind|a|b|mint" (the web's edgeKey). */
  cut: z.array(z.string().max(160)).max(MAP_EDGES_MAX).default([]),
  /** The reader's own lines and text boxes. */
  drawings: drawingsSchema.optional(),
  /** The amount sliders when it was saved. */
  cutoffs: cutoffsSchema.optional(),
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

export async function listMaps(userId: string): Promise<MapSummary[]> {
  const rows = await prisma.asylMap.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: MAPS_PER_USER,
    select: { id: true, title: true, doc: true, shareSlug: true, sharedAt: true, updatedAt: true },
  });
  return rows.map(summary);
}

export async function readMap(userId: string, id: string) {
  const row = await prisma.asylMap.findFirst({ where: { id, userId } });
  if (!row) return null;
  return { ...summary(row), doc: row.doc as unknown as AsylMapDoc };
}

export async function createMap(userId: string, title: string, doc: AsylMapDoc) {
  const count = await prisma.asylMap.count({ where: { userId } });
  if (count >= MAPS_PER_USER) return { error: "cap" as const };
  const row = await prisma.asylMap.create({
    data: { userId, title, doc: cleanDoc(doc) as unknown as Prisma.InputJsonValue },
  });
  return { map: summary(row) };
}

export async function updateMap(userId: string, id: string, title: string, doc: AsylMapDoc) {
  const res = await prisma.asylMap.updateMany({
    where: { id, userId },
    data: { title, doc: cleanDoc(doc) as unknown as Prisma.InputJsonValue },
  });
  return res.count > 0;
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

/** Freezes the map as it stands now behind its link (the same link when it had one). */
export async function shareMap(userId: string, id: string): Promise<{ slug: string } | null> {
  const row = await prisma.asylMap.findFirst({
    where: { id, userId },
    select: { doc: true, shareSlug: true },
  });
  if (!row) return null;
  const slug = row.shareSlug ?? newSlug();
  await prisma.asylMap.update({
    where: { id },
    data: {
      shareSlug: slug,
      sharedDoc: publicDoc(row.doc as unknown as AsylMapDoc) as unknown as Prisma.InputJsonValue,
      sharedAt: new Date(),
    },
  });
  return { slug };
}

export async function unshareMap(userId: string, id: string): Promise<boolean> {
  const res = await prisma.asylMap.updateMany({
    where: { id, userId },
    data: { shareSlug: null, sharedDoc: Prisma.DbNull, sharedAt: null },
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
