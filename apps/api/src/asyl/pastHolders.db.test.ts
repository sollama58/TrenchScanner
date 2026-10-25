// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { addPastHolders, GraphBuilder } from "./graph.js";
import { pastHoldersNote } from "../routes/asyl.js";

const MINT = "AsyPastMint" + "1".repeat(32);
const BARE = "AsyPastBare" + "1".repeat(32);
/** Real ed25519 public keys: past holders must be on the curve, as wallets are. */
const BIG = "BH3uye1nWTdUx8DbbvYtEN4MYx31auwkJbyddwYdKrPp";
const SOLD = "GX3WV54fTnJHuLff5sT92gwttiokUNGMouUjGrZ3h5BK";
const DUST = "4yP9SFqzFdVqBQK4FLFku1yZuNtQ9VwWC2LjGniP7pZ7";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("addPastHolders", () => {
  beforeAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { in: [MINT, BARE] } } });
    const t = await prisma.token.create({ data: { mintAddress: MINT, symbol: "PAST" } });
    await prisma.token.create({ data: { mintAddress: BARE, symbol: "BARE" } });
    await prisma.tokenTradeTape.create({
      data: {
        tokenId: t.id,
        anchorAt: new Date(Date.UTC(2026, 9, 20)),
        reason: "called",
        status: "done",
        windowEnd: new Date(Date.UTC(2026, 9, 21)),
      },
    });
    await prisma.tokenWalletActivity.createMany({
      data: [
        { tokenId: t.id, wallet: BIG, buys: 2, solIn: 3 },
        { tokenId: t.id, wallet: SOLD, buys: 1, sells: 1, solIn: 0.1, solOut: 0.4 },
        { tokenId: t.id, wallet: DUST, buys: 1, solIn: 0.09 },
      ],
    });
  });
  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { in: [MINT, BARE] } } });
  });

  it("draws every buyer of 0.1 SOL or more, sold out or not, and leaves dust off", async () => {
    const g = new GraphBuilder();
    const read = await addPastHolders(g, MINT);
    expect(read).toMatchObject({ total: 2, shown: 2 });
    const graph = g.graph();
    const traded = graph.edges.filter((e) => e.kind === "traded" && e.b === MINT).map((e) => e.a);
    expect(traded.sort()).toEqual([BIG, SOLD].sort());
    expect(graph.nodes.some((n) => n.id === DUST)).toBe(false);
    expect(pastHoldersNote(read)).toBe(
      "2 wallets put 0.1 SOL or more into it, sold out or still holding. Buyers up to 21 Oct 2026, from TrenchScanner's read of its trades.",
    );
  });

  it("keeps to the reader's own least SOL, and to a cap with the full count beside it", async () => {
    const big = await addPastHolders(new GraphBuilder(), MINT, { minSol: 1 });
    expect(big).toMatchObject({ total: 1, shown: 1, minSol: 1 });
    expect(pastHoldersNote(big)).toMatch(/^1 wallet put 1 SOL or more into it/);
    const capped = await addPastHolders(new GraphBuilder(), MINT, { minSol: 0, max: 1 });
    expect(capped).toMatchObject({ total: 3, shown: 1 });
  });

  it("says so when the coin's trades were never read", async () => {
    const read = await addPastHolders(new GraphBuilder(), BARE);
    expect(read).toEqual({ total: 0, shown: 0, minSol: 0.1, tape: null });
    expect(pastHoldersNote(read)).toMatch(/hasn't read this coin's trades/);
  });
});
